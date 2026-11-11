#!/usr/bin/env node
/**
 * EvalHub · API Key 运维脚本
 *
 *   node tools/api-key.mjs --list --tenant platform
 *   node tools/api-key.mjs --create ci-gate --role evaluator --tenant platform --desc "CI 门禁"
 *   node tools/api-key.mjs --revoke 3 --tenant platform
 *
 * 明文只打印一次。脚本不提供「查看」，因为库里只有 sha256 —— 这不是限制，
 * 而是设计：任何能读库的人都拿不到可用密钥。
 */

import { closePool } from '../backend/db.js';
import { getTenantBySlug } from '../backend/tenant/repo.js';
import { createApiKey, listApiKeys, revokeApiKey, rotateApiKey } from '../backend/apikeys.js';
import { DEFAULT_TENANT_SLUG } from '../backend/tenant/context.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('需要 DATABASE_URL');
    process.exit(1);
  }
  const slug = arg('--tenant', DEFAULT_TENANT_SLUG);
  const tenant = await getTenantBySlug(slug);
  if (!tenant) throw new Error(`业务线 ${slug} 不存在`);

  if (argv.includes('--list')) {
    const rows = await listApiKeys(tenant.id);
    if (!rows.length) return console.log(`业务线 ${slug} 还没有任何 API Key`);
    console.log(`业务线 ${slug}（${tenant.name}）`);
    for (const k of rows) {
      const used = k.last_used_at ? new Date(k.last_used_at).toISOString().slice(0, 19).replace('T', ' ') : '从未使用';
      const exp = k.expires_at ? new Date(k.expires_at).toISOString().slice(0, 16).replace('T', ' ') : '不过期';
      const statusCn = { active: '有效', revoked: '已撤销', expired: '已过期' }[k.status] ?? k.status;
      console.log(
        `  #${String(k.id).padEnd(3)} ${k.name.padEnd(24)} ${k.role.padEnd(10)} ${k.key_prefix.padEnd(16)} ` +
        `${statusCn.padEnd(6)} ${String(k.rate_limit_per_min).padStart(5)}/min  ` +
        `24h ${String(k.requests_24h).padStart(4)} 次  到期 ${exp}`,
      );
      if (k.rotated_from) console.log(`        ↳ 由 #${k.rotated_from} 轮换而来`);
    }
    return;
  }

  if (argv.includes('--create')) {
    const name = arg('--create');
    const row = await createApiKey({
      tenantId: tenant.id,
      name,
      role: arg('--role', 'evaluator'),
      description: arg('--desc'),
      rateLimitPerMin: arg('--rate', null),
      expiresAt: arg('--expires', null),
    });
    console.log(`已创建 API Key：${row.name}（${row.role}，业务线 ${slug}）\n`);
    console.log(`  ${row.plain}\n`);
    console.log('  ⚠ 明文只显示这一次，请立刻存进 CI secret；库里只有哈希，丢了只能重建。');
    return;
  }

  if (argv.includes('--rotate')) {
    const id = Number(arg('--rotate'));
    const out = await rotateApiKey({
      tenantId: tenant.id,
      id,
      graceMinutes: Number(arg('--grace', '30')),
    });
    console.log(`已轮换 #${id}：旧密钥 ${out.retired.name} 将在 ${out.grace_minutes} 分钟后失效
`);
    console.log(`  新密钥 ${out.created.name}（${out.created.role}）
`);
    console.log(`  ${out.created.plain}
`);
    console.log('  ⚠ 明文只显示这一次。旧密钥仍可用到宽限期结束，方便你更新完配置再撤。');
    return;
  }

  if (argv.includes('--revoke')) {
    const id = Number(arg('--revoke'));
    const row = await revokeApiKey({ tenantId: tenant.id, id });
    if (!row) throw new Error(`密钥 #${id} 不存在、已撤销或不属于业务线 ${slug}`);
    console.log(`已撤销密钥 #${row.id}（${row.name}）`);
    return;
  }

  console.log(`用法：
  --list   [--tenant slug]
  --create <名称> [--role viewer|evaluator|admin] [--rate 60] [--expires ISO8601] [--tenant slug] [--desc "说明"]
  --rotate <id>   [--grace 30] [--tenant slug]
  --revoke <id>   [--tenant slug]`);
}

main()
  .catch((e) => {
    console.error('失败：', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
