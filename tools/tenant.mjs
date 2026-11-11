#!/usr/bin/env node
/**
 * EvalHub · 业务线（租户）运维脚本
 *
 *   node tools/tenant.mjs --list
 *   node tools/tenant.mjs --create risk-dept --name "风控业务线" --desc "合同与单据合规评测"
 *   node tools/tenant.mjs --add-member risk-dept --email someone@x.com --role evaluator
 *   node tools/tenant.mjs --summary risk-dept
 *
 * 新建业务线会自动复制默认空间当前生效的口径（不可变快照），
 * 保证新业务线「开箱有口径」，第一次建评测任务不会因为找不到 active rubric 失败。
 */

import { closePool } from '../backend/db.js';
import {
  listTenants, createTenant, tenantSummary, getTenantBySlug, assignMember,
} from '../backend/tenant/repo.js';
import { findUserByEmail } from '../backend/users.js';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};

async function main() {
  if (!process.env.DATABASE_URL) {
    console.error('需要 DATABASE_URL（租户功能只在 PostgreSQL 模式可用）');
    process.exit(1);
  }

  if (argv.includes('--list')) {
    const rows = await listTenants();
    console.log('ID   slug                 名称                  成员  状态');
    for (const t of rows) {
      console.log(
        `${String(t.id).padEnd(4)} ${t.slug.padEnd(20)} ${String(t.name).padEnd(20)} ${String(t.member_count).padEnd(5)} ${t.status}`,
      );
    }
    return;
  }

  if (argv.includes('--create')) {
    const slug = arg('--create');
    const name = arg('--name');
    const t = await createTenant({
      slug,
      name,
      description: arg('--desc'),
      cloneRubrics: !argv.includes('--no-clone'),
    });
    console.log(`已创建业务线 ${t.slug}（id=${t.id}），继承口径 ${t.cloned_rubrics} 条`);
    return;
  }

  if (argv.includes('--add-member')) {
    const slug = arg('--add-member');
    const email = arg('--email');
    const role = arg('--role', 'evaluator');
    const t = await getTenantBySlug(slug);
    if (!t) throw new Error(`业务线 ${slug} 不存在`);
    const u = await findUserByEmail(email);
    if (!u) throw new Error(`用户 ${email} 不存在，请先执行 db/create-user.mjs`);
    const m = await assignMember({ userId: u.id, tenantId: t.id, role });
    console.log(`已把 ${email} 加入 ${slug}，角色 ${m.role}`);
    return;
  }

  if (argv.includes('--summary')) {
    const slug = arg('--summary');
    const t = await getTenantBySlug(slug);
    if (!t) throw new Error(`业务线 ${slug} 不存在`);
    const a = await tenantSummary(t.id);
    console.log(`业务线 ${t.slug}（${t.name}）`);
    for (const [k, v] of Object.entries(a)) console.log(`  ${k.padEnd(18)} ${v}`);
    return;
  }

  console.log(`用法：
  --list
  --create <slug> --name "名称" [--desc "描述"] [--no-clone]
  --add-member <slug> --email <邮箱> [--role viewer|evaluator|admin]
  --summary <slug>`);
}

main()
  .catch((e) => {
    console.error('失败：', e.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
