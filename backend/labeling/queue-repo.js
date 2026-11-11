/**
 * EvalHub · 标注队列 · 数据访问层
 *
 * 这里只有 SQL，没有业务判断。所有对外返回的字段都显式列白名单，
 * 特别是盲标接口 —— 绝不 SELECT *，避免以后加列时不小心把 expected_choice
 * 或 split 泄漏到标注界面。
 */

import { query, withTransaction } from '../db.js';
import { tenantId } from '../tenant/context.js';

const BLIND_COLUMNS = 'id, task_type, prompt, answer_a, answer_b, batch_id, created_at, labeled';

export async function listQueue({ limit = 20, offset = 0, onlyPending = true, taskType = null }) {
  const where = [];
  // 租户条件永远排第一个，后续占位符继续用 params.length 推，不会错位
  const params = [tenantId()];
  where.push('tenant_id = $1');
  if (onlyPending) where.push('NOT labeled');
  if (taskType) {
    params.push(taskType);
    where.push(`task_type = $${params.length}`);
  }
  const sql = `SELECT ${BLIND_COLUMNS} FROM v_label_queue
               ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
               ORDER BY id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
  params.push(limit, offset);
  const { rows } = await query(sql, params);
  return rows;
}

export async function findBlind(id) {
  const { rows } = await query(
    `SELECT ${BLIND_COLUMNS} FROM v_label_queue WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId()],
  );
  return rows[0] ?? null;
}

export async function findPairExists(id) {
  const { rows } = await query('SELECT id FROM label_pairs WHERE id = $1 AND tenant_id = $2', [id, tenantId()]);
  return Boolean(rows.length);
}

export async function upsertLabel({ id, annotatorKey, choice, reason, confidence, labelSource }) {
  return withTransaction(async (client) => {
    const tid = tenantId();
    // 先确认这道题属于本业务线；不属于就不写，避免「标了别家的题」这种脏数据
    const owned = await client.query('SELECT 1 FROM label_pairs WHERE id = $1 AND tenant_id = $2', [id, tid]);
    if (!owned.rows.length) return null;
    await client.query(
      `INSERT INTO label_annotations (pair_id, annotator_key, choice, reason, confidence, label_source)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (pair_id, annotator_key) DO UPDATE
         SET choice = EXCLUDED.choice,
             reason = EXCLUDED.reason,
             confidence = EXCLUDED.confidence,
             label_source = EXCLUDED.label_source,
             created_at = now()`,
      [id, annotatorKey, choice, reason ?? null, confidence ?? null, labelSource],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
       VALUES ($1, NULL, 'label.submit', $2, $3)`,
      [tid, id, JSON.stringify({ choice, annotator: annotatorKey, label_source: labelSource })],
    );
    const { rows } = await client.query(
      'SELECT id, pair_id, choice, confidence, label_source, created_at FROM label_annotations WHERE pair_id=$1 AND annotator_key=$2',
      [id, annotatorKey],
    );
    return rows[0];
  });
}

export async function queueStats() {
  const tid = tenantId();
  const { rows } = await query(`
    SELECT
      (SELECT count(*) FROM label_pairs WHERE tenant_id=$1) AS total,
      (SELECT count(*) FROM label_pairs p WHERE p.tenant_id=$1
         AND EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id=p.id)) AS labeled,
      (SELECT count(*) FROM label_annotations a JOIN label_pairs p ON p.id=a.pair_id
        WHERE p.tenant_id=$1 AND a.label_source='human') AS human_labels,
      (SELECT count(*) FROM label_annotations a JOIN label_pairs p ON p.id=a.pair_id
        WHERE p.tenant_id=$1 AND a.label_source='test_fixture') AS fixture_labels,
      (SELECT count(*) FROM label_pairs WHERE tenant_id=$1 AND split='test') AS test_pairs,
      (SELECT count(*) FROM label_pairs WHERE tenant_id=$1 AND split='train') AS train_pairs
  `, [tid]);
  const byTask = await query(`
    SELECT p.task_type, count(*) AS n,
           count(*) FILTER (WHERE EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id=p.id)) AS labeled
      FROM label_pairs p WHERE p.tenant_id=$1 GROUP BY p.task_type ORDER BY p.task_type
  `, [tid]);
  const byChoice = await query(`
    SELECT a.choice, count(*) AS n
      FROM label_annotations a JOIN label_pairs p ON p.id=a.pair_id
     WHERE p.tenant_id=$1 AND a.label_source='human'
     GROUP BY a.choice ORDER BY a.choice
  `, [tid]);
  return {
    ...rows[0],
    by_task_type: byTask.rows,
    // 只统计真人标签，测试夹具不污染对外数字
    by_choice: byChoice.rows,
  };
}

/**
 * 金标准导出（供评估脚本，不经 HTTP）。
 * 严格过滤 label_source='human'，并按 split 限定；绝不把设计意图当标签返回。
 */
export async function goldStandard({ split = null, onlyHuman = true } = {}) {
  const params = [tenantId()];
  const where = ['p.tenant_id = $1'];
  if (onlyHuman) where.push("a.label_source = 'human'");
  if (split) {
    params.push(split);
    where.push(`p.split = $${params.length}`);
  }
  const { rows } = await query(
    `SELECT p.id, p.task_type, p.prompt, p.answer_a, p.answer_b,
            p.reference, p.split, p.expected_choice, p.strategy_a, p.strategy_b,
            a.choice AS human_choice, a.confidence, a.label_source, a.annotator_key
       FROM label_pairs p
       JOIN label_annotations a ON a.pair_id = p.id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY p.id`,
    params,
  );
  return rows;
}
