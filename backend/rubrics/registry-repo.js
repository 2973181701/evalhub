/** EvalHub · Rubric 注册中心 · 数据访问层（只有 SQL） */

import { query, withTransaction } from '../db.js';

export async function listRubrics() {
  const { rows } = await query(
    `SELECT id, key, version, name, description, dimensions, gate,
            content_hash, is_active, created_by, created_at
       FROM rubrics ORDER BY key, version`,
  );
  return rows;
}

export async function getRubric(key, version = null) {
  const { rows } = await query(
    version
      ? `SELECT * FROM rubrics WHERE key=$1 AND version=$2`
      : `SELECT * FROM rubrics WHERE key=$1 AND is_active=true`,
    version ? [key, version] : [key],
  );
  return rows[0] ?? null;
}

/**
 * 注册新版本。事务内完成：查重 → 取下一版本号 → 旧 active 下线 → 插入新 active → 审计。
 * 顺序不能变：部分唯一索引 (key) WHERE is_active 要求先下线再插入。
 */
export async function createRubric(spec, actor = null) {
  return withTransaction(async (client) => {
    const dup = await client.query(
      'SELECT id, key, version, content_hash FROM rubrics WHERE key=$1 AND content_hash=$2',
      [spec.key, spec.content_hash],
    );
    if (dup.rows.length) return { skipped: true, row: dup.rows[0] };

    const v = await client.query(
      'SELECT coalesce(max(version), 0) + 1 AS next_version FROM rubrics WHERE key=$1',
      [spec.key],
    );
    const version = Number(v.rows[0].next_version);

    await client.query(
      'UPDATE rubrics SET is_active=false WHERE key=$1 AND is_active=true',
      [spec.key],
    );

    const ins = await client.query(
      `INSERT INTO rubrics
         (key, version, name, description, dimensions, gate, content_hash, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb,$7,true,$8)
       RETURNING id, key, version, name, dimensions, gate, content_hash, is_active, created_at`,
      [
        spec.key, version, spec.name, spec.description,
        JSON.stringify(spec.dimensions), JSON.stringify(spec.gate),
        spec.content_hash, actor,
      ],
    );

    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES (NULL, 'rubric.register', $1, $2)`,
      [`${spec.key}@v${version}`, JSON.stringify({ content_hash: spec.content_hash.slice(0, 16), actor })],
    );

    return { skipped: false, row: ins.rows[0] };
  });
}

export async function activateVersion(key, version) {
  return withTransaction(async (client) => {
    const target = await client.query('SELECT id FROM rubrics WHERE key=$1 AND version=$2', [key, version]);
    if (!target.rows.length) return null;
    await client.query('UPDATE rubrics SET is_active=false WHERE key=$1 AND is_active=true', [key]);
    const { rows } = await client.query(
      'UPDATE rubrics SET is_active=true WHERE id=$1 RETURNING id, key, version, content_hash',
      [target.rows[0].id],
    );
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES (NULL, 'rubric.activate', $1, $2)`,
      [`${key}@v${version}`, JSON.stringify({ actor: null })],
    );
    return rows[0];
  });
}
