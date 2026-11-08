/**
 * EvalHub · 仓储选择器
 *
 * 规则只有一条：设了 DATABASE_URL 就用 PostgreSQL，否则用 JSON。
 * 上层不感知差异——两种后端导出同一套接口。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJsonRepo } from './json-repo.js';
import { createPgRepo } from './pg-repo.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..', '..');
export const DATA_DIR = path.join(ROOT, 'data');

export async function createRepo() {
  const url = process.env.DATABASE_URL;
  if (url) {
    return createPgRepo({ connectionString: url });
  }
  return createJsonRepo({ dataDir: DATA_DIR });
}
