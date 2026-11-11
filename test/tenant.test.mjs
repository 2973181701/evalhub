/**
 * 租户上下文与权限的单元测试
 *
 * 这里只测「纯函数 + 上下文语义」能覆盖的部分；
 * 真正的 SQL 隔离由端到端验证（两个业务线交叉访问）保证，
 * 因为那部分依赖真实数据库行为（部分唯一索引、NULL 语义），单测替不了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  runWithTenant, currentTenant, tenantId, tenantInfo, TenantContextError, DEFAULT_TENANT_SLUG,
} from '../backend/tenant/context.js';
import { validateSlug, TenantError } from '../backend/tenant/repo.js';
import { tenantFromArgv } from '../backend/tenant/cli.js';

const T1 = { id: 7, slug: 'risk-dept', name: '风控业务线', role: 'admin', source: 'token', enforced: true };
const T2 = { id: 8, slug: 'growth', name: '增长业务线', role: 'viewer', source: 'token', enforced: true };

test('没有租户上下文时 tenantId() 必须抛错（fail-closed）', () => {
  assert.equal(currentTenant(), null);
  assert.throws(() => tenantId(), TenantContextError);
});

test('没有上下文时 tenantInfo() 返回 null，不编造默认租户', () => {
  assert.equal(tenantInfo(), null);
});

test('runWithTenant 内能取到租户，且同步返回函数结果', () => {
  const out = runWithTenant(T1, () => ({ id: tenantId(), slug: currentTenant().slug }));
  assert.deepEqual(out, { id: 7, slug: 'risk-dept' });
});

test('嵌套上下文以最内层为准，退出后恢复外层', () => {
  runWithTenant(T1, () => {
    assert.equal(tenantId(), 7);
    runWithTenant(T2, () => {
      assert.equal(tenantId(), 8);
      assert.equal(currentTenant().slug, 'growth');
    });
    assert.equal(tenantId(), 7, '内层结束后必须恢复外层，否则会串租户');
  });
});

test('异步执行期间上下文仍然有效（这是能替代参数透传的前提）', async () => {
  const got = await runWithTenant(T1, async () => {
    await new Promise((r) => setTimeout(r, 5));
    return tenantId();
  });
  assert.equal(got, 7);
});

test('并发两个租户互不干扰', async () => {
  const [a, b] = await Promise.all([
    runWithTenant(T1, async () => { await new Promise((r) => setTimeout(r, 10)); return tenantId(); }),
    runWithTenant(T2, async () => { await new Promise((r) => setTimeout(r, 2)); return tenantId(); }),
  ]);
  assert.equal(a, 7);
  assert.equal(b, 8);
});

test('tenantInfo 只暴露必要字段，且 enforced 如实反映是否强制', () => {
  const info = runWithTenant(T1, () => tenantInfo());
  assert.deepEqual(info, {
    id: 7, slug: 'risk-dept', name: '风控业务线', role: 'admin', source: 'token', enforced: true,
  });
  const dev = runWithTenant({ ...T1, enforced: false, source: 'header(dev)' }, () => tenantInfo());
  assert.equal(dev.enforced, false, '鉴权关闭时必须自证未强制，避免被误认为隔离已生效');
});

test('slug 校验：拒绝大写、下划线、以数字开头、超长', () => {
  assert.equal(validateSlug('risk-dept'), 'risk-dept');
  assert.equal(validateSlug('a1'), 'a1');
  for (const bad of ['Risk', 'risk_dept', '1risk', 'r', '', 'a'.repeat(33), null]) {
    assert.throws(() => validateSlug(bad), TenantError, `应拒绝：${bad}`);
  }
});

test('CLI 租户参数：缺省落默认空间，显式指定则取指定值', () => {
  assert.equal(tenantFromArgv([]), DEFAULT_TENANT_SLUG);
  assert.equal(tenantFromArgv(['--list']), DEFAULT_TENANT_SLUG);
  assert.equal(tenantFromArgv(['--tenant', 'risk-dept']), 'risk-dept');
  assert.equal(tenantFromArgv(['--tenant']), DEFAULT_TENANT_SLUG, '--tenant 后面没值不能崩');
});
