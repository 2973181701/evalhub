#!/usr/bin/env node
/**
 * EvalHub · 创建 / 重置用户
 *
 * 用法：
 *   DATABASE_URL=postgres://... node db/create-user.mjs --email admin@example.com --password 'Str0ngPass!' --role admin
 *   ... --role evaluator | viewer
 *   ... --name "张三"
 *
 * 说明：同一邮箱重复执行会重置口令与角色（幂等），便于本地反复测试。
 */

const args = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const email = opt('email');
const password = opt('password');
const role = opt('role', 'viewer');
const displayName = opt('name');

if (!email || !password) {
  console.error('用法：node db/create-user.mjs --email <邮箱> --password <口令> [--role admin|evaluator|viewer] [--name 昵称]');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('缺少 DATABASE_URL（用户表只存在于 PostgreSQL 模式）');
  process.exit(2);
}

const { createUser } = await import('../backend/users.js');
const { closePool } = await import('../backend/db.js');

try {
  const u = await createUser({ email, password, role, displayName });
  console.log('已写入用户：');
  console.log(`  id=${u.id}  email=${u.email}  role=${u.role}  display_name=${u.display_name ?? '-'}`);
  console.log('登录示例：');
  console.log(`  curl -X POST http://127.0.0.1:3000/api/auth/login -H 'Content-Type: application/json' \\`);
  console.log(`       -d '{"email":"${email}","password":"<口令>"}'`);
} catch (e) {
  console.error('失败：', e.message);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
