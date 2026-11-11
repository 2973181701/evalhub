/**
 * EvalHub · 数据接入层（Ingestion）
 *
 * 定位：把外部评测集接进平台，产出**不可变的数据集版本**，并留下可审计的批次记录。
 * 这是数据中台「集成」层的最小实现，不是通用 ETL。
 *
 * 三条硬约束：
 *   1. 只接评测数据（id / task_type / prompt / reference），不接业务数据；
 *      样例文件必须标注 synthetic，报告里写明来源。
 *   2. 同 content_hash 不重复建数据集版本（与 datasets 不可变约定一致）；
 *      重跑同一批次直接返回已有结果，幂等。
 *   3. 拒绝的行要留下原因与原始 payload，不能静默丢弃。
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { tenantId } from '../tenant/context.js';

export const ALLOWED_TASK_TYPES = [
  '事实问答', '逻辑推理', '文本摘要', '情感分析', '代码生成', '创意写作',
];

export class IngestError extends Error {
  constructor(message) {
    super(message);
    this.name = 'IngestError';
    this.status = 422;
  }
}

/** 规范化后的内容哈希：按 id 排序，字段顺序固定，保证同内容同哈希 */
export function contentHash(rows) {
  const normalized = [...rows]
    .map((r) => ({
      id: String(r.id),
      task_type: String(r.task_type),
      prompt: String(r.prompt),
      reference: String(r.reference ?? ''),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return crypto.createHash('sha256').update(JSON.stringify(normalized), 'utf8').digest('hex');
}

/**
 * 极简 CSV 解析：支持双引号包裹与转义双引号，不支持内嵌换行。
 * 这个边界是刻意的——评测集题目不该含换行，需要换行请用 JSON。
 */
export function parseCsv(text) {
  const lines = String(text).trim().split(/\r?\n/);
  if (lines.length < 2) throw new IngestError('CSV 至少需要表头和一行数据');
  const splitLine = (line) => {
    const out = [];
    let cur = '';
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i += 1; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  };
  const header = splitLine(lines[0]);
  return lines.slice(1).map((line, i) => {
    const cells = splitLine(line);
    if (cells.length !== header.length) {
      throw new IngestError(`CSV 第 ${i + 2} 行列数与表头不一致（${cells.length} vs ${header.length}）`);
    }
    return Object.fromEntries(header.map((h, j) => [h, cells[j]]));
  });
}

export function parsePayload(text, sourceType = 'json') {
  if (sourceType === 'csv') return parseCsv(text);
  if (sourceType !== 'json') throw new IngestError(`不支持的 source_type：${sourceType}`);
  let data;
  try { data = JSON.parse(String(text)); } catch { throw new IngestError('JSON 解析失败'); }
  if (!Array.isArray(data)) throw new IngestError('JSON 顶层必须是数组');
  return data;
}

/** 纯校验：返回接受行与带原因的拒绝行，不碰数据库 */
export function validateRows(rawRows) {
  const seen = new Set();
  const accepted = [];
  const rejects = [];
  (Array.isArray(rawRows) ? rawRows : []).forEach((r, i) => {
    const bad = (reason) => rejects.push({ row_index: i + 1, reason, payload: r ?? null });
    if (!r || typeof r !== 'object' || Array.isArray(r)) return bad('不是对象');
    const id = String(r.id ?? '').trim();
    const taskType = String(r.task_type ?? '').trim();
    const prompt = String(r.prompt ?? '').trim();
    const reference = String(r.reference ?? '').trim();

    if (!/^[A-Za-z0-9_-]{1,32}$/.test(id)) return bad(`id 非法：${JSON.stringify(r.id)}`);
    if (seen.has(id)) return bad(`id 重复：${id}`);
    if (!ALLOWED_TASK_TYPES.includes(taskType)) return bad(`task_type 不在白名单：${taskType}`);
    if (!prompt) return bad('prompt 为空');
    if (prompt.length > 2000) return bad('prompt 超过 2000 字');

    seen.add(id);
    accepted.push({ id, task_type: taskType, prompt, reference });
  });
  return { accepted, rejects };
}

/** 列出接入批次（含拒绝数），供 API 与 CLI 复用 */
export async function listBatches(limit = 20) {
  const { rows } = await query(
    `SELECT name, source_type, source_uri, content_hash, row_count, accepted_count,
            rejected_count, status, target_dataset, target_version, created_at
       FROM ingestion_batches WHERE tenant_id = $2 ORDER BY id DESC LIMIT $1`,
    [Math.max(1, Math.min(100, Number(limit) || 20)), tenantId()],
  );
  return rows;
}

export async function listRejects(name) {
  const { rows } = await query(
    `SELECT r.row_index, r.reason, r.payload
       FROM ingestion_rejects r
       JOIN ingestion_batches b ON b.id = r.batch_id
      WHERE b.name = $1 AND b.tenant_id = $2 ORDER BY r.row_index`,
    [name, tenantId()],
  );
  return rows;
}

/**
 * 执行接入。dryRun 只校验不写库；正式执行在单事务内完成全部写入。
 * 返回值统一带 status: dry_run | committed | skipped | rejected。
 */
export async function ingest({
  name,
  sourceType = 'json',
  sourceUri,
  text,
  rows: rawRows = null,
  datasetName = 'ingested',
  dryRun = false,
} = {}) {
  const batchName = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(batchName)) {
    throw new IngestError('批次名必须是小写字母/数字开头的 [a-z0-9_-] 串');
  }

  const rows = rawRows ?? parsePayload(text, sourceType);
  const { accepted, rejects } = validateRows(rows);
  const hash = contentHash(accepted);
  const uri = String(sourceUri ?? `${sourceType}:inline`);

  const base = {
    batch: batchName,
    source_type: sourceType,
    source_uri: uri,
    row_count: Array.isArray(rows) ? rows.length : 0,
    accepted_count: accepted.length,
    rejected_count: rejects.length,
    content_hash: hash.slice(0, 16),
    rejects,
  };

  if (dryRun) return { ...base, status: 'dry_run' };
  if (!accepted.length) return { ...base, status: 'rejected', reason: '没有通过校验的行，未写库' };

  // 幂等：同内容已提交过 → 直接返回已有批次，不重复建版本
  const dup = await query(
    `SELECT name, target_dataset, target_version, status FROM ingestion_batches
      WHERE content_hash = $1 AND status = 'committed' AND tenant_id = $2 LIMIT 1`,
    [hash, tenantId()],
  );
  if (dup.rows.length) {
    return {
      ...base, status: 'skipped',
      reason: `内容哈希已由批次 ${dup.rows[0].name} 接入为 ${dup.rows[0].target_dataset}@v${dup.rows[0].target_version}，跳过`,
    };
  }

  const result = await withTransaction(async (client) => {
    const tid = tenantId();
    // 同内容的数据集直接复用，不新建版本。必须限定本租户 ——
    // 否则 A 业务线接入的内容会被 B 业务线「复用」，等于跨租户读数据。
    const existing = await client.query(
      'SELECT id, name, version FROM datasets WHERE content_hash = $1 AND tenant_id = $2 LIMIT 1',
      [hash, tid],
    );
    let datasetId; let datasetVersion; let finalName; let reused = false;

    if (existing.rows.length) {
      datasetId = existing.rows[0].id;
      datasetVersion = existing.rows[0].version;
      finalName = existing.rows[0].name;
      reused = true;
    } else {
      const v = await client.query(
        'SELECT coalesce(max(version), 0) + 1 AS next_version FROM datasets WHERE name = $1 AND tenant_id = $2',
        [datasetName, tid],
      );
      datasetVersion = Number(v.rows[0].next_version);
      finalName = datasetName;
      const ins = await client.query(
        `INSERT INTO datasets (tenant_id, name, version, content_hash, task_types, item_count, created_by, note)
         VALUES ($1,$2,$3,$4,$5::text[],$6,'ingest', $7) RETURNING id`,
        [
          tid, datasetName, datasetVersion, hash,
          [...new Set(accepted.map((r) => r.task_type))],
          accepted.length,
          `来源 ${uri}（synthetic 样例数据，非真实业务数据）`,
        ],
      );
      datasetId = ins.rows[0].id;

      for (const r of accepted) {
        await client.query(
          `INSERT INTO dataset_items (dataset_id, item_key, task_type, prompt, reference)
           VALUES ($1,$2,$3,$4,$5)`,
          [datasetId, r.id, r.task_type, r.prompt, r.reference || null],
        );
      }
    }

    const batch = await client.query(
      `INSERT INTO ingestion_batches
         (tenant_id, name, source_type, source_uri, content_hash, row_count, accepted_count,
          rejected_count, status, target_dataset, target_version, report, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'committed',$9,$10,$11::jsonb,$12)
       RETURNING id, created_at`,
      [
        tid, batchName, sourceType, uri, hash, base.row_count, accepted.length, rejects.length,
        finalName, datasetVersion,
        JSON.stringify({ reused_existing_dataset: reused, task_types: [...new Set(accepted.map((r) => r.task_type))] }),
        '样例评测集接入，数据均标注 synthetic',
      ],
    );
    const batchId = batch.rows[0].id;

    for (const r of rejects) {
      await client.query(
        `INSERT INTO ingestion_rejects (batch_id, row_index, reason, payload)
         VALUES ($1,$2,$3,$4::jsonb)`,
        [batchId, r.row_index, r.reason, JSON.stringify(r.payload)],
      );
    }

    // 血缘：外部文件 → 数据集版本（幂等）
    await client.query(
      `INSERT INTO lineage_events (src_type, src_id, dst_type, dst_id, relation, note)
       VALUES ('external_file',$1,'dataset',$2,'ingested_into',$3)
       ON CONFLICT (src_type,src_id,dst_type,dst_id,relation) DO NOTHING`,
      [uri, `${finalName}@v${datasetVersion}`, `批次 ${batchName} 接入 ${accepted.length} 条`],
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
       VALUES ($1, NULL, 'ingest.commit', $2, $3::jsonb)`,
      [tid, batchName, JSON.stringify({ accepted: accepted.length, rejected: rejects.length, dataset: `${finalName}@v${datasetVersion}` })],
    );

    return {
      batch_id: batchId,
      created_at: batch.rows[0].created_at,
      dataset: `${finalName}@v${datasetVersion}`,
      dataset_id: datasetId,
      reused_existing_dataset: reused,
    };
  });

  return { ...base, status: 'committed', ...result };
}
