/**
 * EvalHub · 租户解析中间件
 *
 * 每个请求都必须落到某个明确的业务线上，绝不允许「没有租户」的请求穿透到 SQL。
 * 解析顺序（后者不能越过前者的权限）：
 *
 *   1. 鉴权开启：租户来自令牌里的 tid。带 X-Tenant 想切换时，**必须**是该租户成员，
 *      否则 403 —— 不允许靠改一个请求头就跨业务线。
 *   2. 鉴权关闭（本地演示/历史验收）：允许 X-Tenant 指定，默认 platform，
 *      并在 /api/health 里自证 `enforced:false`，避免被误认为已生效。
 *   3. JSON 模式：没有租户表，给一个占位上下文（id=0），此模式下所有租户级
 *      SQL 功能（口径/标注/接入/治理）本来就不可用。
 *
 * 租户查询做了 30 秒缓存：租户是低频变更数据，每个请求都查库没必要；
 * 新建租户时主动失效，不会读到脏数据。
 */

import { bearer, verifyToken, authEnabled } from '../auth.js';
import { pgEnabled } from '../db.js';
import { runWithTenant, DEFAULT_TENANT_SLUG } from './context.js';
import { getTenantBySlug, getTenantById, resolveMembership, defaultTenant } from './repo.js';
import { looksLikeApiKey, verifyApiKey } from '../apikeys.js';

const TTL_MS = 30_000;
const cache = new Map(); // key → { value, at }

function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
  const value = loader();
  cache.set(key, { value, at: Date.now() });
  // loader 若返回 rejected promise，别把失败缓存 30 秒
  value.catch?.(() => cache.delete(key));
  return value;
}

export function invalidateTenantCache() {
  cache.clear();
}

async function tenantBySlug(slug) {
  return cached(`slug:${slug}`, () => getTenantBySlug(slug));
}

async function tenantById(id) {
  return cached(`id:${id}`, () => getTenantById(id));
}

async function defaultTenantCached() {
  return cached('default', () => defaultTenant());
}

/**
 * 解析本请求的租户上下文。
 * 抛出带 status 的错误会被中间件转成对应 HTTP 码（403 越权 / 404 租户不存在）。
 */
export async function resolveTenantContext(req) {
  const headerSlug = String(req.headers['x-tenant'] || '').trim() || null;

  if (!pgEnabled()) {
    return {
      id: 0, slug: 'json', name: 'JSON 文件模式',
      role: null, source: 'json-mode', enforced: false,
    };
  }

  const enabled = authEnabled();
  const raw = bearer(req) || '';

  // ── 服务化 API Key（机器调用方）───────────────────────────────────────
  // 必须在 JWT 之前判断：密钥不是 JWT，交给 verifyToken 只会得到 null。
  if (enabled && looksLikeApiKey(raw)) {
    const verified = await verifyApiKey(raw);
    if (!verified) {
      const e = new Error('API Key 无效或已撤销');
      e.status = 401;
      throw e;
    }
    // 密钥只能在自己的业务线内动作，带 X-Tenant 切别的业务线一律拒绝
    if (headerSlug && headerSlug !== verified.tenant.slug) {
      const e = new Error(`该 API Key 只属于业务线 ${verified.tenant.slug}，不能操作 ${headerSlug}`);
      e.status = 403;
      throw e;
    }
    return {
      ...verified.tenant,
      role: verified.role,
      source: 'api-key',
      enforced: true,
      // 审计里要能看出「是哪个密钥干的」，因此把名称写进 actor
      actor: { sub: null, email: `apikey:${verified.key.name}`, role: verified.role, api_key_id: verified.key.id },
      apiKey: verified.key,
    };
  }

  const payload = enabled ? verifyToken(raw) : null;

  // ── 未认证 / 鉴权关闭 ────────────────────────────────────────────────
  if (!payload) {
    const target = headerSlug ? await tenantBySlug(headerSlug) : await defaultTenantCached();
    if (!target) {
      const e = new Error(`业务线 ${headerSlug} 不存在`);
      e.status = 404;
      throw e;
    }
    if (target.status !== 'active') {
      const e = new Error(`业务线 ${target.slug} 已停用`);
      e.status = 403;
      throw e;
    }
    return {
      ...target,
      role: enabled ? null : 'admin',   // 鉴权关闭时本地拥有全部权限（仅演示）
      source: headerSlug ? 'header(dev)' : 'default',
      enforced: false,
    };
  }

  // ── 已认证 ──────────────────────────────────────────────────────────
  let tenant = payload.tid ? await tenantById(Number(payload.tid)) : null;
  if (!tenant) tenant = await defaultTenantCached();   // 老令牌没有 tid，回落到默认空间

  let role = payload.role ?? null;

  if (headerSlug && headerSlug !== tenant.slug) {
    const target = await tenantBySlug(headerSlug);
    if (!target) {
      const e = new Error(`业务线 ${headerSlug} 不存在`);
      e.status = 404;
      throw e;
    }
    const m = await resolveMembership(Number(payload.sub), target.id);
    if (!m) {
      const e = new Error(`无权访问业务线 ${headerSlug}：你不是该业务线成员`);
      e.status = 403;
      throw e;
    }
    if (m.status !== 'active') {
      const e = new Error(`业务线 ${target.slug} 已停用`);
      e.status = 403;
      throw e;
    }
    tenant = target;
    // 角色以「该业务线的成员角色」为准，令牌里的全局角色不得越权覆盖
    role = m.role;
  }

  if (tenant.status !== 'active') {
    const e = new Error(`业务线 ${tenant.slug} 已停用`);
    e.status = 403;
    throw e;
  }

  return {
    ...tenant,
    role,
    source: headerSlug ? 'header' : 'token',
    enforced: true,
    // 供中间件注入 req.user：有些路由（如 GET /api/tenants）不经过 requireRole，
    // 如果只靠 requireRole 赋值，这些路由里 req.user 永远是 undefined，
    // 表现就是「登录了但列表空」。这个坑必须在这里堵住。
    actor: { sub: payload.sub, email: payload.email, role },
  };
}

export function tenantMiddleware() {
  return async (req, res, next) => {
    try {
      const ctx = await resolveTenantContext(req);
      req.tenant = ctx;
      if (ctx.actor) req.user = ctx.actor;
      runWithTenant(ctx, () => next());
    } catch (e) {
      if (e.status) return res.status(e.status).json({ ok: false, error: e.message });
      next(e);
    }
  };
}

export { DEFAULT_TENANT_SLUG };

/**
 * 平台级接口限定：血缘图、质量巡检这类治理动作是**跨租户只读**，
 * 结果里会出现其它业务线的节点名与规则命中项，因此只允许默认空间访问。
 *
 * 为什么不给它们加 tenant 过滤：血缘边没有租户字段（是从表关系派生的），
 * 强行按前缀猜租户会造成「看起来隔离了、其实漏了」。宁可明确限定范围，
 * 也不做半吊子的隔离 —— 后者比不隔离更危险。
 */
export function platformOnly() {
  return (req, res, next) => {
    if (!authEnabled()) return next();               // 本地演示/历史验收
    if (!req.tenant?.enforced) return next();
    if (req.tenant.slug === DEFAULT_TENANT_SLUG) return next();
    return res.status(403).json({
      ok: false,
      error: `数据治理是平台级只读能力，仅 ${DEFAULT_TENANT_SLUG} 可访问（当前业务线 ${req.tenant.slug}）`,
    });
  };
}
