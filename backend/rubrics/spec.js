/**
 * EvalHub · Rubric 规格校验与质量门禁（纯函数，零依赖 DB / HTTP）
 *
 * 单独成模块的原因：口径定义与门禁判定是「中台」最不能出错的部分，
 * 必须能被单测钉死，不能只活在路由里。所有阈值比较统一在这里做，
 * 前端和评测队列都不许自己重算一遍。
 */

import crypto from 'node:crypto';

export const DIMS_DEFAULT = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];

export class RubricError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RubricError';
    this.status = 422;
  }
}

const isNum = (x) => typeof x === 'number' && Number.isFinite(x);
const round4 = (x) => Number(x.toFixed(4));

/**
 * 规范化并校验一份 rubric 规格。
 * 校验通过才允许入库 —— 脏口径一旦注册，后面所有门禁结论都不可信。
 */
export function normalizeRubric(input) {
  if (!input || typeof input !== 'object') throw new RubricError('rubric 必须是对象');

  const key = String(input.key ?? '').trim();
  if (!/^[a-z][a-z0-9_-]{1,47}$/.test(key)) {
    throw new RubricError('key 必须是小写字母开头的 [a-z0-9_-] 串（2-48 位）');
  }
  const name = String(input.name ?? '').trim();
  if (!name || name.length > 120) throw new RubricError('name 必填且不超过 120 字');

  const rawDims = input.dimensions;
  if (!Array.isArray(rawDims) || rawDims.length < 1 || rawDims.length > 10) {
    throw new RubricError('dimensions 必须是 1-10 项的数组');
  }
  const seen = new Set();
  const dimensions = rawDims.map((d) => {
    const k = String(d?.key ?? '').trim();
    if (!/^[a-z][a-z0-9_]{1,31}$/.test(k)) throw new RubricError(`维度 key 非法：${k}`);
    if (seen.has(k)) throw new RubricError(`维度 key 重复：${k}`);
    seen.add(k);
    const weight = Number(d.weight);
    if (!isNum(weight) || weight <= 0 || weight > 1) throw new RubricError(`维度 ${k} 的 weight 必须在 (0,1]`);
    const minScore = d.min_score === undefined ? 0 : Number(d.min_score);
    const maxScore = d.max_score === undefined ? 5 : Number(d.max_score);
    if (!isNum(minScore) || !isNum(maxScore) || minScore >= maxScore) {
      throw new RubricError(`维度 ${k} 的分数范围非法`);
    }
    return {
      key: k,
      label: String(d.label ?? k).trim().slice(0, 40),
      weight: round4(weight),
      min_score: minScore,
      max_score: maxScore,
    };
  });

  const weightSum = dimensions.reduce((s, d) => s + d.weight, 0);
  if (Math.abs(weightSum - 1) > 0.001) {
    throw new RubricError(`维度权重之和必须为 1，当前 ${weightSum.toFixed(4)}`);
  }

  const g = input.gate;
  if (!g || typeof g !== 'object') throw new RubricError('gate 必填');
  const minTotal = Number(g.min_total);
  if (!isNum(minTotal)) throw new RubricError('gate.min_total 必须是数字');
  const globalMin = Math.min(...dimensions.map((d) => d.min_score));
  const globalMax = Math.max(...dimensions.map((d) => d.max_score));
  if (minTotal < globalMin || minTotal > globalMax) {
    throw new RubricError(`gate.min_total 必须在 [${globalMin}, ${globalMax}] 内`);
  }

  const minDims = {};
  if (g.min_dims !== undefined) {
    if (typeof g.min_dims !== 'object' || Array.isArray(g.min_dims)) {
      throw new RubricError('gate.min_dims 必须是对象');
    }
    for (const [k, v0] of Object.entries(g.min_dims)) {
      if (!seen.has(k)) throw new RubricError(`gate.min_dims 含未知维度：${k}`);
      const v = Number(v0);
      if (!isNum(v)) throw new RubricError(`gate.min_dims.${k} 必须是数字`);
      minDims[k] = v;
    }
  }

  const maxFailRate = g.max_fail_rate === undefined ? 1 : Number(g.max_fail_rate);
  if (!isNum(maxFailRate) || maxFailRate < 0 || maxFailRate > 1) {
    throw new RubricError('gate.max_fail_rate 必须在 [0,1]');
  }

  // 键排序后哈希，保证语义相同但书写顺序不同的规格得到同一个 hash
  const canonical = {
    dimensions: dimensions.map((d) => ({
      key: d.key, weight: d.weight, min_score: d.min_score, max_score: d.max_score,
    })),
    gate: {
      min_total: minTotal,
      min_dims: Object.fromEntries(Object.entries(minDims).sort(([a], [b]) => a.localeCompare(b))),
      max_fail_rate: maxFailRate,
    },
  };
  const contentHash = crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');

  return {
    key,
    name,
    description: String(input.description ?? '').slice(0, 500),
    dimensions,
    gate: { min_total: minTotal, min_dims: minDims, max_fail_rate: maxFailRate },
    content_hash: contentHash,
  };
}

/** 从一条评分记录里取总分与各维度分，兼容 {dims:{...}} 与扁平两种结构 */
function pickScores(row, dimKeys) {
  const dims = {};
  for (const k of dimKeys) {
    const v = row?.dims?.[k] ?? row?.[k];
    if (isNum(Number(v)) && v !== null && v !== undefined && v !== '') dims[k] = Number(v);
  }
  const total = row?.total ?? row?.score?.total;
  return { total: isNum(Number(total)) ? Number(total) : null, dims };
}

/**
 * 质量门禁判定。纯函数：同一份 rubric + 同一批分数永远得到同一结论。
 * 阈值比较一律用 >= / <=，即「刚好压线算通过」——这个边界必须显式写死。
 */
export function evaluateGate(rubric, scoreRows = []) {
  const dimKeys = rubric.dimensions.map((d) => d.key);
  const rows = (Array.isArray(scoreRows) ? scoreRows : [])
    .map((r) => pickScores(r, dimKeys))
    .filter((r) => r.total !== null);

  const n = rows.length;
  const metrics = {
    n,
    total_mean: null,
    dim_means: {},
    fail_count: null,
    fail_rate: null,
  };
  if (!n) {
    return { pass: false, reasons: ['没有有效评分样本，拒绝放行'], metrics, rubric: rubricRef(rubric) };
  }

  const mean = (arr) => arr.reduce((s, x) => s + x, 0) / arr.length;
  metrics.total_mean = round4(mean(rows.map((r) => r.total)));
  for (const k of dimKeys) {
    const vals = rows.map((r) => r.dims[k]).filter((v) => v !== undefined);
    if (vals.length) metrics.dim_means[k] = round4(mean(vals));
  }
  metrics.fail_count = rows.filter((r) => r.total < rubric.gate.min_total).length;
  metrics.fail_rate = round4(metrics.fail_count / n);

  const reasons = [];
  if (metrics.total_mean < rubric.gate.min_total) {
    reasons.push(`总分均值 ${metrics.total_mean} < 门槛 ${rubric.gate.min_total}`);
  }
  for (const [k, minV] of Object.entries(rubric.gate.min_dims ?? {})) {
    const v = metrics.dim_means[k];
    if (v === undefined) reasons.push(`缺少维度 ${k} 的分数`);
    else if (v < minV) reasons.push(`维度 ${k} 均值 ${v} < 门槛 ${minV}`);
  }
  if (metrics.fail_rate > rubric.gate.max_fail_rate) {
    reasons.push(`低分样本占比 ${(metrics.fail_rate * 100).toFixed(1)}% > 上限 ${(rubric.gate.max_fail_rate * 100).toFixed(1)}%`);
  }

  return {
    pass: reasons.length === 0,
    reasons,
    metrics,
    rubric: rubricRef(rubric),
  };
}

function rubricRef(r) {
  return { key: r.key, version: r.version ?? null, content_hash: String(r.content_hash ?? '').slice(0, 16) };
}
