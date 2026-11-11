/** EvalHub · Rubric 注册中心 · 数据访问层（只有 SQL） */

import { query, withTransaction } from '../db.js';
import { tenantId } from '../tenant/context.js';

export async function listRubrics() {
  const { rows } = await query(
    `SELECT id, key, version, name, description, dimensions, gate,
            content_hash, is_active, created_by, created_at
       FROM rubrics WHERE tenant_id = $1 ORDER BY key, version`,
    [tenantId()],
  );
  return rows;
}

export async function getRubric(key, version = null) {
  const { rows } = await query(
    version
      ? `SELECT * FROM rubrics WHERE tenant_id=$3 AND key=$1 AND version=$2`
      : `SELECT * FROM rubrics WHERE tenant_id=$2 AND key=$1 AND is_active=true`,
    version ? [key, version, tenantId()] : [key, tenantId()],
  );
  return rows[0] ?? null;
}

/**
 * 注册新版本。事务内完成：查重 → 取下一版本号 → 旧 active 下线 → 插入新 active → 审计。
 * 顺序不能变：部分唯一索引 (key) WHERE is_active 要求先下线再插入。
 */
export async function createRubric(spec, actor = null) {
  return withTransaction(async (client) => {
    const tid = tenantId();
    const dup = await client.query(
      'SELECT id, key, version, content_hash FROM rubrics WHERE tenant_id=$3 AND key=$1 AND content_hash=$2',
      [spec.key, spec.content_hash, tid],
    );
    if (dup.rows.length) return { skipped: true, row: dup.rows[0] };

    const v = await client.query(
      'SELECT coalesce(max(version), 0) + 1 AS next_version FROM rubrics WHERE tenant_id=$2 AND key=$1',
      [spec.key, tid],
    );
    const version = Number(v.rows[0].next_version);

    await client.query(
      'UPDATE rubrics SET is_active=false WHERE tenant_id=$2 AND key=$1 AND is_active=true',
      [spec.key, tid],
    );

    const ins = await client.query(
      `INSERT INTO rubrics
         (tenant_id, key, version, name, description, dimensions, gate, content_hash, is_active, created_by)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,true,$9)
       RETURNING id, key, version, name, dimensions, gate, content_hash, is_active, created_at`,
      [
        tid, spec.key, version, spec.name, spec.description,
        JSON.stringify(spec.dimensions), JSON.stringify(spec.gate),
        spec.content_hash, actor,
      ],
    );

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
       VALUES ($1, NULL, 'rubric.register', $2, $3)`,
      [tid, `${spec.key}@v${version}`, JSON.stringify({ content_hash: spec.content_hash.slice(0, 16), actor })],
    );

    return { skipped: false, row: ins.rows[0] };
  });
}

export async function activateVersion(key, version) {
  return withTransaction(async (client) => {
    const tid = tenantId();
    const target = await client.query(
      'SELECT id FROM rubrics WHERE tenant_id=$3 AND key=$1 AND version=$2',
      [key, version, tid],
    );
    if (!target.rows.length) return null;
    await client.query('UPDATE rubrics SET is_active=false WHERE tenant_id=$2 AND key=$1 AND is_active=true', [key, tid]);
    const { rows } = await client.query(
      'UPDATE rubrics SET is_active=true WHERE id=$1 AND tenant_id=$2 RETURNING id, key, version, content_hash',
      [target.rows[0].id, tid],
    );
    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
       VALUES ($1, NULL, 'rubric.activate', $2, $3)`,
      [tid, `${key}@v${version}`, JSON.stringify({ actor: null })],
    );
    return rows[0];
  });
}
