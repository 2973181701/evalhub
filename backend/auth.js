/**
 * EvalHub · 鉴权（无第三方依赖）
 *
 * 为什么不用 bcrypt / jsonwebtoken：
 *   两个包都能用，但为了一个「签发 + 校验 + 口令哈希」引入供应链，
 *   在评测平台这种要过安全评审的项目里不划算。node:crypto 的 scrypt
 *   （RFC 7914，内存硬）与 HMAC-SHA256 足够，且行为完全可控。
 *
 * 令牌格式：base64url(header).base64url(payload).base64url(hmac)
 *   payload = { sub, email, role, iat, exp }
 *
 * 启用方式（默认关闭，保证既有 43 项接口验收零改动可跑）：
 *   EVALHUB_AUTH=1                 打开鉴权
 *   EVALHUB_JWT_SECRET=xxx         令牌密钥（不设则每次启动随机，重启即失效）
 *   EVALHUB_TOKEN_TTL_SECONDS=28800
 *
 * 角色：admin > evaluator > viewer
 *   写操作（创建评测任务 / 提交标注 / 取消任务）需要 evaluator 及以上
 *   读操作默认不需要令牌（前端看板只读）；需要收紧时设 EVALHUB_AUTH_READ=1
 */

import crypto from 'node:crypto';

const ROLE_RANK = { viewer: 1, evaluator: 2, admin: 3 };

export function authEnabled() {
  return process.env.EVALHUB_AUTH === '1' || process.env.EVALHUB_AUTH === 'true';
}

export function authReadEnabled() {
  return process.env.EVALHUB_AUTH_READ === '1' || process.env.EVALHUB_AUTH_READ === 'true';
}

let cachedSecret = null;
function secret() {
  if (cachedSecret) return cachedSecret;
  const s = process.env.EVALHUB_JWT_SECRET;
  if (s && s.length >= 16) {
    cachedSecret = s;
  } else {
    cachedSecret = crypto.randomBytes(32).toString('hex');
    console.warn(
      '[EvalHub] 未配置 EVALHUB_JWT_SECRET，已生成临时密钥：本次启动签发的令牌在重启后全部失效。',
    );
  }
  return cachedSecret;
}

const b64u = (buf) =>
  Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (str) =>
  Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

// ─────────────────────────── 口令哈希 ───────────────────────────

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, {
    N: SCRYPT.N,
    r: SCRYPT.r,
    p: SCRYPT.p,
  });
  return `scrypt$${SCRYPT.N}$${salt}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  try {
    const [algo, n, salt, hex] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(hex, 'hex');
    const actual = crypto.scryptSync(password, salt, expected.length, {
      N: Number(n),
      r: SCRYPT.r,
      p: SCRYPT.p,
    });
    // 定长比较，避免时序侧信道
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

// ─────────────────────────── 令牌 ───────────────────────────

export function signToken(
  { id, email, role, tenantId = null, tenantSlug = null },
  ttlSeconds = Number(process.env.EVALHUB_TOKEN_TTL_SECONDS || 28800),
) {
  const now = Math.floor(Date.now() / 1000);
  // tid 是「该用户在该业务线的角色」对应的租户；role 也是该租户内的角色，
  // 不是全局角色 —— 同一个人在不同业务线的权限可以不同。
  const payload = { sub: String(id), email, role, tid: tenantId, tslug: tenantSlug, iat: now, exp: now + ttlSeconds };
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = b64u(crypto.createHmac('sha256', secret()).update(`${head}.${body}`).digest());
  return { token: `${head}.${body}.${sig}`, expires_in: ttlSeconds, payload };
}

export function verifyToken(token) {
  if (typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [head, body, sig] = parts;
  const expect = b64u(crypto.createHmac('sha256', secret()).update(`${head}.${body}`).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(unb64u(body));
  } catch {
    return null;
  }
  if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ─────────────────────────── 中间件 ───────────────────────────

export function bearer(req) {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

/**
 * 角色门禁。auth 未启用时直接放行（保证历史验收脚本与本地演示不被拦）。
 * 启用后：缺令牌 401，角色不足 403，并把 req.user 交给后续 handler。
 */
export function requireRole(minRole = 'evaluator', { allowWhenDisabled = true } = {}) {
  return (req, res, next) => {
    if (!authEnabled()) {
      if (allowWhenDisabled) return next();
      return res.status(503).json({ ok: false, error: '鉴权未启用（EVALHUB_AUTH），该接口拒绝服务' });
    }
    // 服务化 API Key 已在租户中间件校验过，这里直接用它解析出的角色，
    // 不再尝试当成 JWT 解析（那只会得到 null 并误报 401）。
    if (req.tenant?.source === 'api-key') {
      const effectiveRole = req.tenant.role;
      const needK = ROLE_RANK[minRole] ?? 2;
      if ((ROLE_RANK[effectiveRole] ?? 0) < needK) {
        return res.status(403).json({
          ok: false,
          error: `权限不足：需要 ${minRole} 及以上，当前 ${effectiveRole}（API Key）`,
        });
      }
      req.user = { ...(req.user ?? {}), role: effectiveRole };
      return next();
    }

    const token = bearer(req);
    const payload = token ? verifyToken(token) : null;
    if (!payload) {
      return res.status(401).json({
        ok: false,
        error: '未认证：请在 Authorization: Bearer <token> 中携带令牌',
      });
    }
    // 多租户：权限按「当前业务线内的角色」判定。
    // 中间件在切换业务线时会用成员角色覆盖令牌里的角色，这里必须优先用它 ——
    // 否则带着 A 业务线的 admin 令牌去访问 B 业务线，会拿到 A 的角色继续当管理员。
    const effectiveRole = req.tenant?.enforced ? (req.tenant.role ?? payload.role) : payload.role;
    const need = ROLE_RANK[minRole] ?? 2;
    const got = ROLE_RANK[effectiveRole] ?? 0;
    if (got < need) {
      return res.status(403).json({
        ok: false,
        error: `权限不足：需要 ${minRole} 及以上，当前 ${effectiveRole}`,
      });
    }
    req.user = { ...payload, role: effectiveRole };
    next();
  };
}

export function requireRead() {
  if (!authEnabled() || !authReadEnabled()) {
    return (_req, _res, next) => next();
  }
  return requireRole('viewer');
}

export function authStatus() {
  return {
    enabled: authEnabled(),
    read_protected: authReadEnabled(),
    secret_source: process.env.EVALHUB_JWT_SECRET ? 'env' : 'ephemeral',
    token_ttl_seconds: Number(process.env.EVALHUB_TOKEN_TTL_SECONDS || 28800),
  };
}
