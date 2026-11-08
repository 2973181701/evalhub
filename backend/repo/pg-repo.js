/**
 * EvalHub · PostgreSQL 仓储
 *
 * 与 json-repo 导出同一套接口（snapshot / annotations / saveAnnotation），
 * 上层 store.js 只依赖这个接口，因此两种后端对调用方完全等价。
 *
 * 关键设计：
 *   - 只读部分（题目 / A-B 对 / 回答）在启动时一次性载入内存，保持原有「同步读」签名不变，
 *     server.js 里的所有 GET 接口一行都不用改。
 *   - 写路径（提交标注）走数据库，并记 audit_logs；调用方需 await。
 *   - 数据集取 name 匹配的最新 version；数据集不可变，历史版本仍可查询。
 */

import { getPool, query } from '../db.js';

const DATASET_NAME = process.env.EVALHUB_DATASET || 'evalhub-core';
const DATASET_VERSION = process.env.EVALHUB_DATASET_VERSION
  ? Number(process.env.EVALHUB_DATASET_VERSION)
  : null;

export async function createPgRepo({ connectionString }) {
  // 复用全局连接池（DATABASE_URL 已由 repo/index.js 读取）
  if (!process.env.DATABASE_URL) process.env.DATABASE_URL = connectionString;
  const pool = getPool();

  // 启动即验连：配置错了要立刻炸，而不是等到第一个请求
  try {
    await query('select 1');
  } catch (e) {
    throw new Error(`无法连接 PostgreSQL（${e.message}）。检查 DATABASE_URL，或改用 JSON 模式（不设该变量）。`);
  }

  const { rows: dsRows } = await pool.query(
    `SELECT id, version, content_hash, item_count
       FROM datasets
      WHERE name = $1
        AND ($2::int IS NULL OR version = $2::int)
      ORDER BY version DESC
      LIMIT 1`,
    [DATASET_NAME, DATASET_VERSION],
  );
  if (!dsRows.length) {
    throw new Error(
      `数据库中找不到数据集 ${DATASET_NAME}。请先执行： DATABASE_URL=... node db/migrate.mjs`,
    );
  }
  const dataset = dsRows[0];
  const datasetId = dataset.id;

  const [{ rows: items }, { rows: pairs }, { rows: answers }] = await Promise.all([
    pool.query(
      `SELECT item_key, task_type, prompt, reference FROM dataset_items WHERE dataset_id = $1 ORDER BY id`,
      [datasetId],
    ),
    pool.query(
      `SELECT item_key, task_type, prompt, reference, answer_a, answer_b,
              strategy_a, strategy_b, strategy_a_label, strategy_b_label
         FROM dataset_pairs WHERE dataset_id = $1 ORDER BY id`,
      [datasetId],
    ),
    pool.query(
      `SELECT item_key, task_type, prompt, answer FROM dataset_answers WHERE dataset_id = $1 ORDER BY id`,
      [datasetId],
    ),
  ]);

  // 列名 → 原 JSON 字段名，保证上层拿到的对象结构与 JSON 模式逐字段一致
  const prompts = items.map((r) => ({
    id: r.item_key,
    task_type: r.task_type,
    prompt: r.prompt,
    reference: r.reference ?? '',
  }));
  const pairList = pairs.map((r) => ({
    id: r.item_key,
    task_type: r.task_type,
    prompt: r.prompt,
    reference: r.reference ?? '',
    answer_A: r.answer_a,
    answer_B: r.answer_b,
    strategy_A: r.strategy_a,
    strategy_B: r.strategy_b,
    strategy_A_label: r.strategy_a_label,
    strategy_B_label: r.strategy_b_label,
  }));
  const answerList = answers.map((r) => ({
    id: r.item_key,
    task_type: r.task_type,
    prompt: r.prompt,
    answer: r.answer,
  }));

  const byId = {
    prompt: new Map(prompts.map((p) => [p.id, p])),
    pair: new Map(pairList.map((p) => [p.id, p])),
    answer: new Map(answerList.map((a) => [a.id, a])),
  };

  async function readAnnotations() {
    const { rows } = await pool.query(
      `SELECT a.item_key, a.choice, a.reason, a.confidence, a.submitted_at, a.source,
              COALESCE(p.task_type, '') AS task_type
         FROM annotations a
         LEFT JOIN dataset_pairs p
                ON p.dataset_id = a.dataset_id AND p.item_key = a.item_key
        WHERE a.dataset_id = $1
        ORDER BY a.item_key`,
      [datasetId],
    );
    return rows.map((r) => ({
      id: r.item_key,
      task_type: r.task_type,
      choice: r.choice,
      reason: r.reason,
      confidence: r.confidence,
      annotated_at: new Date(r.submitted_at).toISOString(),
      source: r.source,
    }));
  }

  let annCache = await readAnnotations();

  // 运行期新提交的标注：与 JSON 模式一样，用「同 id 覆盖种子」的语义对外呈现
  function merged(rows) {
    const map = new Map(
      rows.filter((a) => a.source === 'seed').map((a) => [a.id, { ...a, source: 'seed' }]),
    );
    for (const a of rows.filter((x) => x.source !== 'seed')) {
      map.set(a.id, { ...a, source: 'submitted' });
    }
    return [...map.values()];
  }

  return {
    mode: 'postgres',
    describe: () => ({
      mode: 'postgres',
      dataset: DATASET_NAME,
      version: dataset.version,
      content_hash: String(dataset.content_hash).slice(0, 16),
    }),
    /** 供评测队列写入 eval_runs 时定位数据集版本 */
    datasetRef: () => ({ id: datasetId, name: DATASET_NAME, version: dataset.version }),
    snapshot() {
      return {
        prompts,
        pairs: pairList,
        answers: answerList,
        seeds: annCache.filter((a) => a.source === 'seed'),
        submitted: annCache.filter((a) => a.source !== 'seed'),
        byId,
      };
    },
    annotations() {
      return merged(annCache);
    },
    async saveAnnotation(record) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // 匿名标注者（annotator_id IS NULL）无法靠唯一约束去重（NULL != NULL），
        // 所以显式 delete + insert。
        // ⚠️ 必须限定 source='submitted'：种子行是冻结的历史快照，
        // 允许被「覆盖展示」，但绝不能被物理删除，否则种子数会无声减少。
        await client.query(
          `DELETE FROM annotations
            WHERE dataset_id = $1 AND item_key = $2
              AND annotator_id IS NULL AND source = 'submitted'`,
          [datasetId, record.id],
        );
        await client.query(
          `INSERT INTO annotations (dataset_id, item_key, annotator_id, choice, reason, confidence, source)
           VALUES ($1, $2, NULL, $3, $4, $5, 'submitted')`,
          [datasetId, record.id, record.choice, record.reason ?? null, record.confidence ?? null],
        );
        await client.query(
          `INSERT INTO audit_logs (actor_id, action, target, detail)
           VALUES (NULL, 'annotation.submit', $1, $2)`,
          [`${DATASET_NAME}@v${dataset.version}:${record.id}`, JSON.stringify({ choice: record.choice })],
        );
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        client.release();
      }
      annCache = await readAnnotations();
    },
    async close() {
      // 连接池由 db.js 统一管理，这里不关闭，避免和队列/其他模块抢生命周期
    },
  };
}
