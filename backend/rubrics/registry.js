/**
 * EvalHub · Rubric 注册中心 · 业务层
 * 不 import HTTP 类型；控制器只负责把参数传进来。
 */

import * as repo from './registry-repo.js';
import { normalizeRubric, evaluateGate, RubricError } from './spec.js';

export { RubricError, evaluateGate, normalizeRubric };

export async function list() {
  const rows = await repo.listRubrics();
  // 按 key 分组，方便前端一次拿到「有哪些口径 + 各自有哪些版本」
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.key)) groups.set(r.key, { key: r.key, active: null, versions: [] });
    const g = groups.get(r.key);
    g.versions.push({
      version: r.version,
      name: r.name,
      content_hash: String(r.content_hash).slice(0, 16),
      is_active: r.is_active,
      created_at: r.created_at,
    });
    if (r.is_active) g.active = r.version;
  }
  return [...groups.values()];
}

export async function get(key, version = null) {
  const row = await repo.getRubric(key, version ? Number(version) : null);
  if (!row) {
    const e = new RubricError(`未找到 rubric：${key}${version ? `@v${version}` : '（无 active 版本）'}`);
    e.status = 404;
    throw e;
  }
  return row;
}

export async function register(input, actor = null) {
  const spec = normalizeRubric(input);
  return repo.createRubric(spec, actor);
}

/** 门禁：取指定版本（默认 active）→ 纯函数计算 → 不落库 */
export async function gate({ key, version = null, scores = [] }) {
  if (typeof key !== 'string' || !key.trim()) {
    throw new RubricError('key 必填');
  }
  const rubric = await get(key.trim(), version);
  return evaluateGate(rubric, scores);
}

export async function activate(key, version) {
  const row = await repo.activateVersion(key, Number(version));
  if (!row) {
    const e = new RubricError(`未找到版本：${key}@v${version}`);
    e.status = 404;
    throw e;
  }
  return row;
}
