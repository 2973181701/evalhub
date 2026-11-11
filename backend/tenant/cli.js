/**
 * EvalHub · CLI 租户入口
 *
 * 运维脚本不在 HTTP 请求里，拿不到请求级租户上下文。按 fail-closed 约定，
 * scoped 查询会直接抛错——这正是我们想要的：宁可脚本失败，也不要它「默认查全库」。
 *
 * 用法：
 *   node tools/xxx.mjs --tenant risk-dept
 *   不传 --tenant 时落在默认空间 platform
 */

import { runWithTenant, DEFAULT_TENANT_SLUG } from './context.js';
import { getTenantBySlug } from './repo.js';

export function tenantFromArgv(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--tenant');
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return DEFAULT_TENANT_SLUG;
}

/** 在指定业务线上下文里跑一个 async 函数 */
export async function runInTenant(fn, { slug = null } = {}) {
  const target = slug ?? tenantFromArgv();
  const tenant = await getTenantBySlug(target);
  if (!tenant) {
    throw new Error(`业务线 ${target} 不存在。先执行：node tools/tenant.mjs --create ${target} --name "..."`);
  }
  if (tenant.status !== 'active') {
    throw new Error(`业务线 ${target} 已停用，拒绝执行写操作`);
  }
  console.log(`[tenant] ${tenant.slug} (${tenant.name})`);
  return runWithTenant({ ...tenant, role: 'admin', source: 'cli', enforced: true }, fn);
}
