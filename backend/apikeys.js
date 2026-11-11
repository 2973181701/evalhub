/**
 * EvalHub · 服务化 API Key（含生命周期与限流）
 *
 * 与人用的 JWT 分开：JWT 短命、按会话签发，适合人；API Key 长期、绑定租户与角色，
 * 适合 CI / 训练平台 / 发布系统这类「机器调用方」。
 *
 * 安全约定：
 *   - 明文只在创建时返回一次，库里只存 sha256；不提供「查看密钥」接口。
 *   - 校验失败一律走同一条错误，不区分「不存在 / 已撤销 / 已过期 / secret 错」。
 *   - last_used_at 最多每 60 秒更新一次，否则每个请求都写库会拖慢热路径。
 *
 * 生命周期：
 *   - expires_at 到期即失效（不是「下次清理时失效」）。
 *   - 轮换时旧密钥改名留档并设宽限期，新旧并行一段时间，避免调用方瞬间断流。
 *
 * 限流：
 *   - 固定窗口（按分钟）+ 数据库自增计数，多副本共享同一份额度。
 *     放内存会导致「额度 × 副本数」，那等于没限。
 */

import crypto from 'node:crypto';
import { query } from './db.js';

const PREFIX = 'ehk_';
const PREFIX_LEN = 8;
const SECRET_BYTES = 24;          // base64url 后 32 字符
// 前缀由 base64url 生成，可能含 - / _；只允许字母数字会让「自己生成的密钥」被判非法
export const KEY_PATTERN = /^ehk_[A-Za-z0-9_-]{8}\.[A-Za-z0-9_-]{16,}$/;
const ROLES = ['viewer', 'evaluator', 'admin'];
export const DEFAULT_RATE_LIMIT = 60;
const MAX_RATE_LIMIT = 100_000;

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

/**
 * 密钥是否可用。抽成纯函数是因为这里有三个容易写错的时间边界：
 *   - 已撤销：永不复活（即使 expires_at 还没到）
 *   - 已过期：到期那一刻即失效，不是「下次清理」
 *   - 恰好等于到期时间：判过期（安全侧取严），避免边界抖动
 */
export function isKeyUsable({ revoked_at: revokedAt = null, expires_at: expiresAt = null } = {}, now = new Date()) {
  if (revokedAt) return false;
  if (!expiresAt) return true;
  return new Date(expiresAt).getTime() > now.getTime();
}

/**
 * 轮换时给旧密钥改的名字。
 * 为什么改名而不是直接撤销：`(tenant_id, name)` 唯一，若不改名，新密钥没法沿用原名；
 * 而「名字代表逻辑用途、旧密钥带 @retired 后缀留档」比「一长串日期后缀」更好读，
 * 也让审计时能一眼看出这是被轮换掉的那把。
 */
export function retiredName(name, id) {
  return `${String(name).slice(0, 48)}@retired-${id}`;
}

export function normalizeRateLimit(value) {
  if (value === null || value === undefined || value === '') return DEFAULT_RATE_LIMIT;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1 || n > MAX_RATE_LIMIT) {
    throw new ApiKeyError(`每分钟配额需在 1–${MAX_RATE_LIMIT} 之间，收到 ${value}`);
  }
  return Math.floor(n);
}

export class ApiKeyError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ApiKeyError';
    this.status = status;
  }
}

// ─────────────────────────── 数据访问 ───────────────────────────

export async function createApiKey({
  tenantId, name, role = 'evaluator', description = null, actorId = null,
  rateLimitPerMin = null, expiresAt = null, rotatedFrom = null,
}) {
  const keyName = String(name ?? '').trim();
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/.test(keyName)) {
    throw new ApiKeyError('密钥名必须是小写字母/数字开头，允许 [a-z0-9_-]，2–64 位');
  }
  if (!ROLES.includes(role)) throw new ApiKeyError(`role 非法：${role}`);
  if (!tenantId) throw new ApiKeyError('缺少业务线，密钥必须绑定到具体业务线', 500);
  const limit = normalizeRateLimit(rateLimitPerMin);

  const { plain, prefix, hash } = generateApiKey();
  const { rows } = await query(
    `INSERT INTO api_keys
       (tenant_id, name, key_prefix, key_hash, role, description, created_by, rate_limit_per_min, expires_at, rotated_from)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (tenant_id, name) DO NOTHING
     RETURNING id, tenant_id, name, key_prefix, role, description, rate_limit_per_min, expires_at, created_at`,
    [tenantId, keyName, prefix, hash, role, description, actorId, limit, expiresAt, rotatedFrom],
  );
  if (!rows.length) throw new ApiKeyError(`业务线内已存在同名密钥：${keyName}`, 409);

  await query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
     VALUES ($1, $2, 'apikey.create', $3, $4::jsonb)`,
    [tenantId, actorId, keyName, JSON.stringify({ role, prefix, rate_limit_per_min: limit, expires_at: expiresAt })],
  );

  // 明文只在这一行返回，之后任何接口都取不到
  return { ...rows[0], plain, warning: '明文只显示这一次，请立即保存到 CI secret 中' };
}

/**
 * 轮换：发一把新密钥接替旧密钥，旧密钥改名留档并在宽限期后失效。
 * 不做「一次性撤销旧密钥再建新的」——那会让调用方在两次部署之间必然断流。
 */
export async function rotateApiKey({ tenantId, id, graceMinutes = 30, actorId = null, rateLimitPerMin = null }) {
  const grace = Math.max(0, Math.min(7 * 24 * 60, Number(graceMinutes) || 0));

  const { rows: oldRows } = await query(
    `SELECT id, name, role, description, rate_limit_per_min, revoked_at, expires_at
       FROM api_keys WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  const old = oldRows[0];
  if (!old) throw new ApiKeyError('密钥不存在或不属于当前业务线', 404);
  if (old.revoked_at) throw new ApiKeyError('密钥已撤销，不能轮换；请直接新建', 409);
  if (!isKeyUsable(old)) throw new ApiKeyError('密钥已过期，不能轮换；请直接新建', 409);

  // 先改名腾出唯一约束，再设宽限期
  const { rows: retired } = await query(
    `UPDATE api_keys
        SET name = $3, expires_at = now() + ($4 || ' minutes')::interval
      WHERE id = $1 AND tenant_id = $2
      RETURNING id, name, expires_at`,
    [id, tenantId, retiredName(old.name, old.id), grace],
  );

  const created = await createApiKey({
    tenantId,
    name: old.name,
    role: old.role,
    description: old.description,
    actorId,
    rateLimitPerMin: rateLimitPerMin ?? old.rate_limit_per_min,
    rotatedFrom: old.id,
  });

  await query(
    `INSERT INTO audit_logs (tenant_id, actor_id, action, target, detail)
     VALUES ($1, $2, 'apikey.rotate', $3, $4::jsonb)`,
    [tenantId, actorId, old.name, JSON.stringify({ old_id: old.id, new_id: created.id, grace_minutes: grace })],
  );

  return { created, retired: retired[0], grace_minutes: grace };
}

/**
 * 校验密钥。返回 { tenant, key, role, limit } 或 null。
 * 不抛错，交给中间件决定用哪种 HTTP 码（这里不泄漏失败原因）。
 */
export async function verifyApiKey(plain) {
  if (!looksLikeApiKey(plain)) return null;
  const hash = hashApiKey(plain.trim());

  const { rows } = await query(
    `SELECT k.id, k.name, k.role, k.tenant_id, k.key_prefix, k.last_used_at,
            k.revoked_at, k.expires_at, k.rate_limit_per_min,
            t.slug, t.name AS tenant_name, t.status AS tenant_status
       FROM api_keys k
       JOIN tenants t ON t.id = k.tenant_id
      WHERE k.key_hash = $1
      LIMIT 1`,
    [hash],
  );
  if (!rows.length) return null;
  const row = rows[0];

  // 撤销/过期与「查不到」返回同一个 null：调用方只该知道「这把 key 不能用」
  if (!isKeyUsable(row)) return null;
  if (row.tenant_status !== 'active') return null;

  // 热路径节流：60 秒内不重复写 last_used_at
  if (!row.last_used_at || Date.now() - new Date(row.last_used_at).getTime() > 60_000) {
    query('UPDATE api_keys SET last_used_at = now() WHERE id = $1', [row.id]).catch(() => {});
  }

  return {
    key: { id: row.id, name: row.name, prefix: row.key_prefix, role: row.role },
    tenant: { id: row.tenant_id, slug: row.slug, name: row.tenant_name },
    role: row.role,
    expiresAt: row.expires_at,
    limit: row.rate_limit_per_min,
  };
}

/**
 * 固定窗口限流：同一分钟内的请求数自增后与配额比较。
 * 返回 { allowed, used, limit, retryAfterSeconds }。
 *
 * 这是「先计数再判断」，因此被拒绝的请求也会占用一次计数 —— 故意如此：
 * 否则被限流的客户端可以无限重试而不消耗额度，压测时就打不穿防护。
 */
export async function consumeRateLimit(keyId, limit) {
  const { rows } = await query(
    `INSERT INTO api_key_usage (key_id, window_start, count)
     VALUES ($1, date_trunc('minute', now()), 1)
     ON CONFLICT (key_id, window_start) DO UPDATE SET count = api_key_usage.count + 1
     RETURNING count,
               ceil(extract(epoch FROM (date_trunc('minute', now()) + interval '1 minute' - now())))::int AS retry_after`,
    [keyId],
  );
  const used = rows[0]?.count ?? 1;
  return {
    allowed: used <= limit,
    used,
    limit,
    retryAfterSeconds: rows[0]?.retry_after ?? 60,
  };
}

/** 清理历史窗口计数（由 server 的定时器每小时调用一次） */
export async function pruneUsage() {
  const { rowCount } = await query(
    "DELETE FROM api_key_usage WHERE window_start < now() - interval '2 days'",
  );
  return rowCount;
}

export async function listApiKeys(tenantId) {
  const { rows } = await query(
    `SELECT k.id, k.name, k.key_prefix, k.role, k.description, k.created_at,
            k.last_used_at, k.revoked_at, k.expires_at, k.rate_limit_per_min, k.rotated_from,
            (SELECT coalesce(sum(u.count), 0) FROM api_key_usage u
              WHERE u.key_id = k.id AND u.window_start > now() - interval '24 hours')::int AS requests_24h
       FROM api_keys k WHERE k.tenant_id = $1 ORDER BY k.id`,
    [tenantId],
  );
  const now = new Date();
  return rows.map((r) => ({
    ...r,
    key_prefix: maskKey(r.key_prefix),
    // 三种状态一眼可辨：有效 / 已撤销 / 已过期（含宽限期内的旧密钥）
    active: isKeyUsable(r, now),
    status: r.revoked_at ? 'revoked' : (isKeyUsable(r, now) ? 'active' : 'expired'),
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
