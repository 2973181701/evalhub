/**
 * EvalHub · 租户与成员仓储
 *
 * 只放 SQL 与参数校验，不做权限判断（权限在 server.js 的中间件里做）。
 * 所有查询都固定走 pg（JSON 模式下没有租户表，调用方需先判断 pgEnabled）。
 */

import { query, withTransaction } from '../db.js';
import { DEFAULT_TENANT_SLUG } from './context.js';

const SLUG_RE = /^[a-z][a-z0-9-]{1,31}$/;
const ROLES = ['viewer', 'evaluator', 'admin'];

export class TenantError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'TenantError';
    this.status = status;
  }
}

export function validateSlug(slug) {
  if (!SLUG_RE.test(String(slug ?? ''))) {
    throw new TenantError('slug 需为 2–32 位小写字母、数字或连字符，且以字母开头');
  }
  return slug;
}

export async function listTenants() {
  const { rows } = await query(
    `SELECT t.id::int, t.slug, t.name, t.description, t.status, t.created_at,
            (SELECT count(*) FROM user_tenants m WHERE m.tenant_id = t.id)::int AS member_count
       FROM tenants t ORDER BY t.id`,
  );
  return rows;
}

export async function getTenantBySlug(slug) {
  const { rows } = await query(
    'SELECT id::int, slug, name, description, status FROM tenants WHERE slug = $1',
    [slug],
  );
  return rows[0] ?? null;
}

export async function getTenantById(id) {
  const { rows } = await query(
    'SELECT id::int, slug, name, description, status FROM tenants WHERE id = $1',
    [id],
  );
  return rows[0] ?? null;
}

export async function defaultTenant() {
  const t = await getTenantBySlug(DEFAULT_TENANT_SLUG);
  if (!t) throw new TenantError('默认租户 platform 不存在，请先执行迁移 db/migrations/007_multitenancy.sql', 500);
  return t;
}

/**
 * 新建业务线。
 * 同时把默认空间当前生效的口径复制成新租户的 v1 —— 新业务线必须「开箱有口径」，
 * 否则第一次建评测任务会因为找不到 active rubric 而失败。复制的是**不可变快照**，
 * 之后两边各自演进，互不影响。
 */
export async function createTenant({ slug, name, description = null, cloneRubrics = true, actorId = null }) {
  validateSlug(slug);
  if (!name || !String(name).trim()) throw new TenantError('name 必填');

  return withTransaction(async (client) => {
    const exists = await client.query('SELECT 1 FROM tenants WHERE slug = $1', [slug]);
    if (exists.rows.length) throw new TenantError(`业务线 ${slug} 已存在`, 409);

    const ins = await client.query(
      `INSERT INTO tenants (slug, name, description) VALUES ($1, $2, $3)
       RETURNING id::int, slug, name, description, status, created_at`,
      [slug, String(name).trim(), description],
    );
    const tenant = ins.rows[0];

    let cloned = 0;
    if (cloneRubrics) {
      const src = await client.query(
        `SELECT r.key, r.name, r.description, r.dimensions, r.gate, r.content_hash
           FROM rubrics r
           JOIN tenants t ON t.id = r.tenant_id
          WHERE t.slug = $1 AND r.is_active`,
        [DEFAULT_TENANT_SLUG],
      );
      for (const r of src.rows) {
        await client.query(
          `INSERT INTO rubrics
             (tenant_id, key, version, name, description, dimensions, gate, content_hash, is_active, created_by)
           VALUES ($1,$2,1,$3,$4,$5::jsonb,$6::jsonb,$7,true,NULL)`,
          [tenant.id, r.key, r.name, r.description, JSON.stringify(r.dimensions), JSON.stringify(r.gate), r.content_hash],
        );
        cloned += 1;
      }
    }

    // 创建者自动成为该业务线的 admin：否则新建完业务线自己都进不去，
    // 还得再找平台管理员分配权限，实际使用中一定会被吐槽。
    if (actorId) {
      await client.query(
        `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, 'admin')
         ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = 'admin'`,
        [actorId, tenant.id],
      );
    }

    await client.query(
      `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
       VALUES ($1, $2, 'tenant.create', $3, $4::jsonb)`,
      [tenant.id, actorId, slug, JSON.stringify({ name, cloned_rubrics: cloned })],
    );

    return { ...tenant, cloned_rubrics: cloned };
  });
}

export async function listMemberships(userId) {
  const { rows } = await query(
    `SELECT m.tenant_id::int AS tenant_id, t.slug, t.name, m.role, t.status
       FROM user_tenants m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1
      ORDER BY t.id`,
    [userId],
  );
  return rows;
}

export async function resolveMembership(userId, tenantIdValue) {
  const { rows } = await query(
    `SELECT m.tenant_id::int AS tenant_id, t.slug, t.name, m.role, t.status
       FROM user_tenants m
       JOIN tenants t ON t.id = m.tenant_id
      WHERE m.user_id = $1 AND m.tenant_id = $2`,
    [userId, tenantIdValue],
  );
  return rows[0] ?? null;
}

export async function assignMember({ userId, tenantId: tid, role = 'evaluator' }) {
  if (!ROLES.includes(role)) throw new TenantError(`role 非法：${role}`);
  const { rows } = await query(
    `INSERT INTO user_tenants (user_id, tenant_id, role) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, tenant_id) DO UPDATE SET role = EXCLUDED.role
     RETURNING tenant_id::int AS tenant_id, role`,
    [userId, tid, role],
  );
  return rows[0];
}

export async function removeMember({ userId, tenantId: tid }) {
  const { rowCount } = await query(
    'DELETE FROM user_tenants WHERE user_id = $1 AND tenant_id = $2',
    [userId, tid],
  );
  return rowCount > 0;
}

/** 租户资产概览：用于切租户时给一眼可见的规模，也用于验收隔离是否生效 */
export async function tenantSummary(tid) {
  const { rows } = await query(
    `SELECT
       (SELECT count(*) FROM datasets WHERE tenant_id IS NULL OR tenant_id = $1)::int AS datasets,
       (SELECT count(*) FROM datasets WHERE tenant_id = $1)::int AS own_datasets,
       (SELECT count(*) FROM rubrics WHERE tenant_id = $1 AND is_active)::int AS active_rubrics,
       (SELECT count(*) FROM eval_runs WHERE tenant_id = $1)::int AS runs,
       (SELECT count(*) FROM label_pairs WHERE tenant_id = $1)::int AS label_pairs,
       (SELECT count(*) FROM label_pairs p WHERE p.tenant_id = $1
          AND EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id = p.id))::int AS labeled_pairs,
       (SELECT count(*) FROM ingestion_batches WHERE tenant_id = $1)::int AS ingestion_batches`,
    [tid],
  );
  return rows[0];
}
