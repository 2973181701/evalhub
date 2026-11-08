/**
 * EvalHub · 用户（仅 PostgreSQL 模式）
 *
 * JSON 模式没有用户表，因此鉴权开启时登录会明确报 503，
 * 而不是静默放行——「配置错了还假装能用」比直接报错危险得多。
 */

import { pgEnabled, query } from './db.js';
import { verifyPassword, hashPassword } from './auth.js';

// bigint 默认会被 pg 驱动当字符串返回，前端拿 id 做比较会踩「1 !== "1"，统一转 int
const PUBLIC_FIELDS = 'id::int AS id, email, display_name, role, is_active, created_at, last_login_at';

export async function findUserByEmail(email) {
  if (!pgEnabled()) return null;
  const { rows } = await query(
    `SELECT id, email, display_name, role, is_active, password_hash FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  return rows[0] ?? null;
}

export async function login(email, password) {
  if (!pgEnabled()) {
    const e = new Error('当前为 JSON 模式（未配置 DATABASE_URL），用户表不存在，无法登录');
    e.status = 503;
    throw e;
  }
  const user = await findUserByEmail(email);
  // 用户不存在与口令错误返回同一个错误，避免账号枚举
  if (!user || !user.is_active || !verifyPassword(password, user.password_hash)) {
    const e = new Error('邮箱或密码错误');
    e.status = 401;
    throw e;
  }
  await query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
  await query(
    `INSERT INTO audit_logs (actor_id, action, target, detail) VALUES ($1, 'auth.login', $2, '{}'::jsonb)`,
    [user.id, user.email],
  );
  return user;
}

export async function listUsers() {
  if (!pgEnabled()) return [];
  const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM users ORDER BY id`);
  return rows;
}

export async function createUser({ email, password, role = 'viewer', displayName = null }) {
  if (!pgEnabled()) {
    const e = new Error('当前为 JSON 模式，用户表不存在');
    e.status = 503;
    throw e;
  }
  if (!email || !password) {
    const e = new Error('email 与 password 必填');
    e.status = 400;
    throw e;
  }
  if (!['admin', 'evaluator', 'viewer'].includes(role)) {
    const e = new Error(`role 非法：${role}`);
    e.status = 400;
    throw e;
  }
  if (String(password).length < 8) {
    const e = new Error('口令至少 8 位');
    e.status = 400;
    throw e;
  }
  const { rows } = await query(
    `INSERT INTO users (email, password_hash, display_name, role)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (email) DO UPDATE
       SET password_hash = EXCLUDED.password_hash,
           role = EXCLUDED.role,
           display_name = COALESCE(EXCLUDED.display_name, users.display_name),
           is_active = true
     RETURNING ${PUBLIC_FIELDS}`,
    [email, hashPassword(password), displayName, role],
  );
  await query(
    `INSERT INTO audit_logs (actor_id, action, target, detail)
     VALUES (NULL, 'user.upsert', $1, $2::jsonb)`,
    [email, JSON.stringify({ role })],
  );
  return rows[0];
}

export async function getUserById(id) {
  if (!pgEnabled()) return null;
  const { rows } = await query(`SELECT ${PUBLIC_FIELDS} FROM users WHERE id = $1`, [id]);
  return rows[0] ?? null;
}
