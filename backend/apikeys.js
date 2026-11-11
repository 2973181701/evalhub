/**
 * EvalHub · 服务化 API Key
 *
 * 与人用的 JWT 分开：JWT 短命、按会话签发，适合人；API Key 长期、绑定租户与角色，
 * 适合 CI / 训练平台 / 发布系统这类「机器调用方」。
 *
 * 安全约定：
 *   - 明文只在创建时返回一次，库里只存 sha256；不提供「查看密钥」接口。
 *   - 校验失败一律走同一条错误，不区分「不存在 / 已撤销 / 前缀对但 secret 错」。
 *   - last_used_at 最多每 60 秒更新一次，否则每个请求都写库会拖慢热路径。
 */

import crypto from 'node:crypto';
import { query } from './db.js';

const PREFIX = 'ehk_';
const PREFIX_LEN = 8;
const SECRET_BYTES = 24;          // base64url 后 32 字符
// 前缀由 base64url 生成，可能含 - / _；只允许字母数字会让「自己生成的密钥」被判非法
export const KEY_PATTERN = /^ehk_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{16,}$/;
const ROLES = ['viewer', 'evaluator', 'admin'];

// ─────────────────────────── 纯函数（可单测） ───────────────────────────

/** 生成一把新密钥：ehk_<8位标识>.<secret>，返回明文与入库所需字段 */
export function generateApiKey() {
  const slug = crypto.randomBytes(PREFIX_LEN).toString('base64url').slice(0, PREFIX_LEN);
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const plain = `${PREFIX}${slug}.${secret}`;
  return { plain, prefix: `${PREFIX}${slug}`, hash: hashApiKey(plain) };
}

export function hashApiKey(plain) {
  return crypto.createHash('sha256').update(String(plain), 'utf8').digest('hex');
}

/** 只判形态，不判有效性（有效性必须查库） */
export function looksLikeApiKey(value) {
  return typeof value === 'string' && KEY_PATTERN.test(value.trim());
}

/** 对外展示用：ehk_ab12cd34…（永不回显 secret） */
export function maskKey(prefix) {
  return `${prefix}…`;
}

export class ApiKeyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ApiKeyError';
    this.status = status;
  }
}

// ─────────────────────────── 数据访问 ───────────────────────────

export async function createApiKey({ tenantId, name, role = 'evaluator', description = null, actorId = null }) {
  const keyName = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(keyName)) {
    throw new ApiKeyError('密钥名必须是小写字母/数字开头，允许 [a-z0-9_-]，2–64 位');
  }
  if (!ROLES.includes(role)) throw new ApiKeyError(`role 非法：${role}`);
  if (!tenantId) throw new ApiKeyError('缺少业务线，密钥必须绑定到具体业务线', 500);

  const { plain, prefix, hash } = generateApiKey();
  const { rows } = await query(
    `INSERT INTO api_keys (tenant_id, name, key_prefix, key_hash, role, description, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id, tenant_id, name, key_prefix, role, description, created_at`,
    [tenantId, keyName, prefix, hash, role, description, actorId],
  );
  if (!rows.length) throw new ApiKeyError(`业务线内已存在同名密钥：${keyName}`, 409);

  await query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
     VALUES ($1, $2, 'apikey.create', $3, $4::jsonb)`,
    [tenantId, actorId, keyName, JSON.stringify({ role, prefix })],
  );

  // 明文只在这一行返回，之后任何接口都取不到
  return { ...rows[0], plain, warning: '明文只显示这一次，请立即保存到 CI secret 中' };
}

/**
 * 校验密钥。返回 { tenant, key } 或 null。
 * 不抛错，交给中间件决定用哪种 HTTP 码（这里不泄漏失败原因）。
 */
export async function verifyApiKey(plain) {
  if (!looksLikeApiKey(plain)) return null;
  const hash = hashApiKey(plain.trim());

  const { rows } = await query(
    `SELECT k.id, k.name, k.role, k.tenant_id, k.key_prefix, k.last_used_at,
            t.slug, t.name AS tenant_name, t.status AS tenant_status
       FROM api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL
      LIMIT 1`,
    [hash],
  );
  if (!rows.length) return null;
  const row = rows[0];
  if (row.tenant_status !== 'active') return null;

  // 热路径节流：60 秒内不重复写 last_used_at
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }

  return {
    key: { id: row.id, name: row.name, prefix: row.key_prefix, role: row.role },
    tenant: { id: row.tenant_id, slug: row.slug, name: row.tenant_name },
    role: row.role,
  };
}

export async function listApiKeys(tenantId) {
  const { rows } = await query(
    `SELECT id, name, key_prefix, role, description, created_at, last_used_at, revoked_at,
            (revoked_at IS NULL) AS active
       FROM api_keys WHERE tenant_id = $1 ORDER BY id`,
    [tenantId],
  );
  return rows.map((r) => ({
    ...r,
    key_prefix: maskKey(r.key_prefix),
    // 明确告诉调用方「取不回明文」，避免有人以为是自己找错地方
    plaintext_retrievable: false,
  }));
}

export async function revokeApiKey({ tenantId, id, actorId = null }) {
  const { rows } = await query(
    `UPDATE api_keys SET revoked_at = now()
      WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL
      RETURNING id, name, revoked_at`,
    [id, tenantId],
  );
  if (!rows.length) return null;
  await query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
     VALUES ($1, $2, 'apikey.revoke', $3, '{}'::jsonb)`,
    [tenantId, actorId, rows[0].name],
  );
  return rows[0];
}
