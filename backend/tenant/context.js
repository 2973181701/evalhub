/**
 * EvalHub · 租户上下文
 *
 * 为什么用 AsyncLocalStorage 而不是把 tenantId 一路当参数传：
 *   这个平台的 SQL 分散在 repo / rubrics / labeling / governance / jobs 五处，
 *   逐个改签名会漏，而漏掉的那一处就是**跨租户数据泄漏**。用上下文可以让
 *   所有 scoped 查询统一从 `tenantId()` 取，并且**缺上下文直接抛错**（fail-closed），
 *   而不是悄悄回落成「查全部」。
 *
 * 两条硬规则：
 *   1. 任何 scoped 查询必须走 `tenantId()`；没有上下文就报错，绝不默认全库。
 *   2. 后台任务（评测 worker）不在 HTTP 请求里，必须用 runWithTenant(run.tenant_id)
 *      显式进出，否则会拿不到上下文而失败——这是有意的，宁可失败也不跨租户写。
 */

import { AsyncLocalStorage } from 'node:async_hooks';

const als = new AsyncLocalStorage();

export const DEFAULT_TENANT_SLUG = 'platform';

export class TenantContextError extends Error {
  constructor(message = '缺少租户上下文：该查询必须限定业务线') {
    super(message);
    this.name = 'TenantContextError';
    this.status = 500;
    this.code = 'TENANT_CONTEXT_MISSING';
  }
}

/** 在指定租户上下文中执行（HTTP 请求 / 后台任务 / CLI 脚本共用） */
export function runWithTenant(ctx, fn) {
  return als.run(ctx, fn);
}

/** 当前租户上下文；不在上下文里返回 null（供需要「有就用、没有就跳过」的地方判断） */
export function currentTenant() {
  return als.getStore() ?? null;
}

/**
 * 当前租户 id。**没有上下文就抛错** —— 这是 fail-closed 的关键：
 * 忘了包上下文的代码会在第一次查询就炸，而不是安静地把全库数据返回给某个租户。
 */
export function tenantId() {
  const ctx = als.getStore();
  if (!ctx?.id) throw new TenantContextError();
  return ctx.id;
}

/** 当前租户的展示信息（供响应体/健康检查自证） */
export function tenantInfo() {
  const ctx = als.getStore();
  if (!ctx) return null;
  return {
    id: ctx.id,
    slug: ctx.slug,
    name: ctx.name,
    role: ctx.role ?? null,
    source: ctx.source ?? 'unknown',
    enforced: Boolean(ctx.enforced),
  };
}

/**
 * 把「全局资产 + 本租户资产」合成一个 SQL 条件。
 * 用于基线数据集这类全局只读资产的查询：`tenant_id IS NULL OR tenant_id = $n`。
 */
export function tenantScopeSql(column = 'tenant_id') {
  return `(${column} IS NULL OR ${column} = ${tenantId()})`;
}
