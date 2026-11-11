/**
 * EvalHub · 数据血缘（派生边 + 递归查询）
 *
 * 原则：lineage_edges 是**派生数据**，真相源是各业务表本身。
 * 因此不做写路径埋点（容易漏、容易和真相源不一致），而是提供 rebuild：
 * 任何时候都能从当前库状态重建全图，重建结果可复算、可对比。
 *
 * 已知缺口（不伪造边）：eval_runs 未记录使用的 rubric 版本，
 * 所以「某次评测用了哪个口径」暂不可追，见 knownGaps()。
 */

import { query, withTransaction } from '../db.js';
import { buildGraph, traverse } from './metrics.js';

/** 从现有表关系派生边。全部用 INSERT ... SELECT，不写循环、不逐行查。 */
const DERIVE_SQL = `
INSERT INTO lineage_edges (src_type, src_id, dst_type, dst_id, relation, metadata)
SELECT 'dataset', d.name || '@v' || d.version::text,
       'run', r.id::text, 'used_by',
       jsonb_build_object('provider', r.provider, 'status', r.status, 'dataset_id', d.id)
  FROM eval_runs r JOIN datasets d ON d.id = r.dataset_id

UNION ALL
SELECT 'run', r.id::text, 'result_set', r.id::text, 'produces',
       jsonb_build_object('rows', count(e.id), 'total_items', r.total_items)
  FROM eval_runs r LEFT JOIN eval_results e ON e.run_id = r.id
 GROUP BY r.id, r.total_items

UNION ALL
SELECT 'dataset', d.name || '@v' || d.version::text,
       'annotation_set', a.dataset_id::text, 'labeled_by',
       jsonb_build_object('rows', a.n)
  FROM (SELECT dataset_id, count(*) AS n FROM annotations GROUP BY dataset_id) a
  JOIN datasets d ON d.id = a.dataset_id

UNION ALL
SELECT 'label_batch', b.name, 'label_pair_set', b.name, 'contains',
       jsonb_build_object('pairs', count(p.id), 'content_hash', left(b.content_hash, 16))
  FROM label_batches b LEFT JOIN label_pairs p ON p.batch_id = b.id
 GROUP BY b.name, b.content_hash

UNION ALL
SELECT 'rubric', r.rubric_key || '@v' || r.rubric_version::text,
       'run', r.id::text, 'scored_by',
       jsonb_build_object('status', r.status, 'provider', r.provider)
  FROM eval_runs r
 WHERE r.rubric_key IS NOT NULL AND r.rubric_version IS NOT NULL

UNION ALL
SELECT 'label_batch', b.name, 'label_annotation_set', b.name, 'annotated_by',
       jsonb_build_object('human_labels', count(*) FILTER (WHERE a.label_source = 'human'),
                          'fixture_labels', count(*) FILTER (WHERE a.label_source = 'test_fixture'))
  FROM label_batches b
  JOIN label_pairs p ON p.batch_id = b.id
  LEFT JOIN label_annotations a ON a.pair_id = p.id
 GROUP BY b.name
ON CONFLICT (src_type, src_id, dst_type, dst_id, relation) DO NOTHING`;

/** 无法从表关系推导、但有据可查的外部接入 / 报告导出事件 */
export const EXTERNAL_EVENTS = [
  {
    src_type: 'external_file', src_id: 'data/prompts_extra.json',
    dst_type: 'label_batch', dst_id: 'queue-v1', relation: 'ingested_into',
    note: 'build_label_queue.mjs 读取该文件生成 120 组 A/B',
  },
  {
    src_type: 'dataset', src_id: 'evalhub-core@v1',
    dst_type: 'report', dst_id: 'reports/baseline_2026-11-08.md', relation: 'produced',
    note: 'glm-4-flash 基线报告，20/20 有效，总分 3.88',
  },
];

export async function seedEvents() {
  for (const e of EXTERNAL_EVENTS) {
    await query(
      `INSERT INTO lineage_events (src_type, src_id, dst_type, dst_id, relation, note)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (src_type, src_id, dst_type, dst_id, relation) DO NOTHING`,
      [e.src_type, e.src_id, e.dst_type, e.dst_id, e.relation, e.note],
    );
  }
  const { rows } = await query('SELECT count(*) AS n FROM lineage_events');
  return Number(rows[0].n);
}

export async function rebuild() {
  return withTransaction(async (client) => {
    await client.query('DELETE FROM lineage_edges');
    await client.query(DERIVE_SQL);
    const { rows } = await client.query('SELECT count(*) AS n FROM lineage_edges');
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES (NULL, 'lineage.rebuild', 'all', $1)`,
      [JSON.stringify({ edges: Number(rows[0].n) })],
    );
    return { edges: Number(rows[0].n) };
  });
}

async function allEdges() {
  const { rows } = await query(`
    SELECT src_type, src_id, dst_type, dst_id, relation, 'derived' AS source
      FROM lineage_edges
    UNION ALL
    SELECT src_type, src_id, dst_type, dst_id, relation, 'event' AS source
      FROM lineage_events
  `);
  return rows;
}

export async function graph() {
  const edges = await allEdges();
  const g = buildGraph(edges);
  return { ...g, gaps: knownGaps() };
}

export async function walk(type, id, direction = 'downstream') {
  const edges = await allEdges();
  return traverse(edges, type, id, direction);
}

/** 明确列出当前血缘追不到的地方，不假装全链路可追 */
export function knownGaps() {
  return [
    {
      gap: '历史 eval_runs 未记录 rubric 版本',
      impact: '这些 run 没有 scored_by 血缘边；新建任务已自动记录口径版本',
      fix: '历史数据保持 NULL，不伪造回填；对比时以 caveat 标注',
      resolved_for_new_records: true,
    },
    {
      gap: 'label_pairs 与 datasets 无外键',
      impact: '标注队列与评测集之间的血缘只能靠外部事件登记',
      fix: '接入时显式写入 source_dataset 字段',
      resolved_for_new_records: false,
    },
  ];
}
