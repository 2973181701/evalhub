/**
 * EvalHub · PostgreSQL 连接池单例
 *
 * 为什么要单例：pg-repo 与评测任务队列都要用库，
 * 各自 new Pool 会让连接数变成 N 倍，且 pool.end() 互相踩。
 */

import pg from 'pg';

let pool = null;

export function pgEnabled() {
  return Boolean(process.env.DATABASE_URL);
}

export function getPool() {
  if (!pgEnabled()) {
    throw new Error('未配置 DATABASE_URL，当前为 JSON 模式，没有数据库连接池');
  }
  if (!pool) {
    pool = new pg.Pool({
      connectionString: process.env.DATABASE_URL,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
  }
  return pool;
}

export async function query(text, params) {
  return getPool().query(text, params);
}

export async function withTransaction(fn) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
  }
}
