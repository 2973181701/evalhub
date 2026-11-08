/**
 * EvalHub · 标注队列 · 业务层
 *
 * 不 import 任何 HTTP 类型（req/res），控制器只负责把参数传进来。
 * 核心职责：
 *   1. 边界校验 —— 前端传什么都不能信
 *   2. 保证「标签来源」不被 HTTP 客户端伪造（路由层不接受 label_source）
 *   3. 盲标保证 —— 对外只给 listQueue / findBlind 的字段白名单
 */

import * as repo from './queue-repo.js';

export class LabelingError extends Error {
  constructor(message, status = 422) {
    super(message);
    this.name = 'LabelingError';
    this.status = status;
  }
}

const CHOICES = ['A', 'B', '平手'];

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export async function listQueue(params = {}) {
  const limit = clampInt(params.limit, 1, 100, 20);
  const offset = clampInt(params.offset, 0, 1_000_000, 0);
  return repo.listQueue({
    limit,
    offset,
    onlyPending: params.onlyPending !== false,
    taskType: typeof params.taskType === 'string' && params.taskType.trim()
      ? params.taskType.trim().slice(0, 40)
      : null,
  });
}

export async function getPair(id) {
  const row = await repo.findBlind(id);
  if (!row) throw new LabelingError(`未找到待标注样本 ${id}`, 404);
  return row;
}

export async function submitLabel({
  id,
  choice,
  reason = null,
  confidence = null,
  annotatorKey = 'anonymous',
  // 仅供内部脚本使用；HTTP 路由不传这个参数，永远走 'human'
  labelSource = 'human',
} = {}) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new LabelingError('id 格式不合法');
  }
  if (!CHOICES.includes(choice)) {
    throw new LabelingError(`choice 必须是 A / B / 平手，收到 ${JSON.stringify(choice)}`);
  }
  if (confidence !== null && confidence !== undefined && confidence !== '') {
    const c = Number(confidence);
    if (!Number.isInteger(c) || c < 1 || c > 5) {
      throw new LabelingError('confidence 必须是 1-5 的整数');
    }
    confidence = c;
  } else {
    confidence = null;
  }
  if (reason !== null && reason !== undefined && String(reason).length > 500) {
    throw new LabelingError('reason 最多 500 字');
  }
  if (!['human', 'test_fixture'].includes(labelSource)) {
    throw new LabelingError('非法的 label_source');
  }
  if (!(await repo.findPairExists(id))) {
    throw new LabelingError(`未找到样本 ${id}`, 404);
  }

  const record = await repo.upsertLabel({
    id,
    annotatorKey: String(annotatorKey).slice(0, 120) || 'anonymous',
    choice,
    reason: reason ? String(reason).slice(0, 500) : null,
    confidence,
    labelSource,
  });
  return record;
}

export async function stats() {
  const s = await repo.queueStats();
  const num = (x) => Number(x ?? 0);
  return {
    total: num(s.total),
    labeled: num(s.labeled),
    pending: num(s.total) - num(s.labeled),
    human_labels: num(s.human_labels),
    fixture_labels: num(s.fixture_labels),
    test_pairs: num(s.test_pairs),
    train_pairs: num(s.train_pairs),
    by_task_type: s.by_task_type.map((r) => ({ task_type: r.task_type, n: num(r.n), labeled: num(r.labeled) })),
    by_choice: s.by_choice.map((r) => ({ choice: r.choice, n: num(r.n) })),
  };
}

export async function goldStandard(options) {
  return repo.goldStandard(options);
}

export const __test = { clampInt };
