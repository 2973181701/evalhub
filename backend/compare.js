/**
 * EvalHub · 两次评测的对比
 *
 * 为什么单独成模块：对比是「平台可信度」的核心动作——
 * 换模型、改 prompt、上微调，都必须回答「到底好没好、好在哪个维度」。
 * 这段逻辑要能被单测覆盖，所以不写在路由里。
 *
 * 关键约定（决定了结论是否成立）：
 *   1. 只在**两边都跑过的题**上比较。题集不同还硬比均值，等于拿苹果比橘子。
 *   2. 数据集版本不同则标记 not_comparable —— 题都不一样了，差值没有意义。
 *   3. 差值统一用「B - A」，正数表示 B 更好。方向写死在返回值里，前端不再自己算。
 *   4. 两次任务必须属于同一业务线。跨租户的 run 一律当「不存在」返回 404，
 *      不返回 403 —— 403 会泄漏「这个 id 确实存在，只是不属于你」。
 */

import { query, pgEnabled } from './db.js';
import { tenantId } from './tenant/context.js';

const DIMS = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];

async function loadRun(id) {
  const { rows } = await query(
    `SELECT id, dataset_id, provider, model, config_hash, status,
            total_items, item_keys, done_items, failed_items, created_at, finished_at,
            rubric_key, rubric_version
       FROM eval_runs WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId()],
  );
  return rows[0] ?? null;
}

async function loadResults(id) {
  const { rows } = await query(
    `SELECT item_key, scores, total, latency_ms, error FROM eval_results WHERE run_id = $1`,
    [id],
  );
  const map = new Map();
  for (const r of rows) {
    map.set(r.item_key, {
      id: r.item_key,
      total: r.total === null ? null : Number(r.total),
      latency_ms: r.latency_ms,
      error: r.error,
      ...DIMS.reduce((acc, d) => {
        acc[d] = r.scores?.[d] ?? null;
        return acc;
      }, {}),
      // 约束门禁字段：本轮新增，历史 run 没有 → 保持 null，不要当成 0
      constraint: typeof r.scores?.constraint === 'number' ? r.scores.constraint : null,
      gated_total: typeof r.scores?.gated_total === 'number' ? r.scores.gated_total : null,
      gate: typeof r.scores?.gate === 'string' ? r.scores.gate : null,
    });
  }
  return map;
}

/** 数据集版本：不同版本不参与对比 */
async function loadDatasetVersion(datasetId) {
  const { rows } = await query(`SELECT id, name, version, content_hash FROM datasets WHERE id = $1`, [datasetId]);
  return rows[0] ?? null;
}

const mean = (arr) => (arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0);
const round = (x, n = 2) => Number(x.toFixed(n));

function aggregate(list) {
  const valid = list.filter((x) => !x.error && x.total !== null);
  const nums = (key) =>
    valid.map((x) => x[key]).filter((v) => typeof v === 'number' && Number.isFinite(v));
  const constraint = nums('constraint');
  const gated = nums('gated_total');
  return {
    n: valid.length,
    total: round(mean(valid.map((x) => x.total))),
    dims: Object.fromEntries(DIMS.map((d) => [d, round(mean(valid.map((x) => Number(x[d]) || 0)))])),
    // 约束门禁只在有数据时给值：历史 run 没有这一维，填 0 会污染均值
    constraint: constraint.length ? round(mean(constraint)) : null,
    gated_total: gated.length ? round(mean(gated)) : null,
    gate_counts: {
      pass: valid.filter((x) => x.gate === 'pass').length,
      warn: valid.filter((x) => x.gate === 'warn').length,
      fail: valid.filter((x) => x.gate === 'fail').length,
      unknown: valid.filter((x) => !x.gate).length,
    },
    latency_p50: (() => {
      const lat = valid.map((x) => x.latency_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
      return lat.length ? lat[Math.floor(lat.length / 2)] : null;
    })(),
  };
}

/**
 * @returns {Promise<object>} 对比结果；不可比时返回 { comparable:false, reason }
 */
export async function compareRuns(idA, idB) {
  if (!pgEnabled()) {
    const e = new Error('对比需要 PostgreSQL（JSON 模式没有任务表）');
    e.status = 503;
    throw e;
  }

  const [a, b] = await Promise.all([loadRun(idA), loadRun(idB)]);
  if (!a) {
    const e = new Error(`任务不存在：${idA}`);
    e.status = 404;
    throw e;
  }
  if (!b) {
    const e = new Error(`任务不存在：${idB}`);
    e.status = 404;
    throw e;
  }

  const [dsA, dsB] = await Promise.all([loadDatasetVersion(a.dataset_id), loadDatasetVersion(b.dataset_id)]);
  const sameDataset = a.dataset_id === b.dataset_id;
  if (!sameDataset) {
    return {
      comparable: false,
      reason: `两次任务使用的数据集版本不同（${dsA?.name}@v${dsA?.version} vs ${dsB?.name}@v${dsB?.version}），题目都不一样，差值没有意义`,
      a: meta(a, dsA),
      b: meta(b, dsB),
    };
  }

  // 口径血缘：双方都有记录且不同 → 判定不可比；任一方无记录（历史 run）不阻断，
  // 只在结果里标注 caveat，避免把「没记录」误当成「口径不同」。
  const rubricLabel = (r) => (r.rubric_key ? `${r.rubric_key}@v${r.rubric_version}` : '未记录');
  const bothRecorded = Boolean(a.rubric_key && b.rubric_key);
  const sameRubric = !bothRecorded
    || (a.rubric_key === b.rubric_key && a.rubric_version === b.rubric_version);
  const rubricCaveat = bothRecorded
    ? null
    : '其中一次任务未记录评分口径（历史 run），结论按数据集相同处理';

  if (!sameRubric) {
    return {
      comparable: false,
      reason: `两次任务使用不同的评分口径（${rubricLabel(a)} vs ${rubricLabel(b)}），分数口径不一致，差值没有意义`,
      a: meta(a, dsA),
      b: meta(b, dsB),
    };
  }

  const [ra, rb] = await Promise.all([loadResults(idA), loadResults(idB)]);
  const common = [...ra.keys()].filter((k) => rb.has(k)).sort();
  const onlyA = [...ra.keys()].filter((k) => !rb.has(k)).sort();
  const onlyB = [...rb.keys()].filter((k) => !ra.has(k)).sort();

  if (!ra.size || !rb.size) {
    const who = !ra.size ? `A（${idA.slice(0, 8)}）` : `B（${idB.slice(0, 8)}）`;
    return {
      comparable: false,
      reason: `${who} 还没有任何结果（可能仍在排队或运行中），等它跑完再对比`,
      a: meta(a, dsA),
      b: meta(b, dsB),
    };
  }

  if (!common.length) {
    return {
      comparable: false,
      reason: `两次任务没有共同题目的结果（A ${ra.size} 条 / B ${rb.size} 条，交集 0），无法逐条对比`,
      a: meta(a, dsA),
      b: meta(b, dsB),
      only_a: onlyA,
      only_b: onlyB,
    };
  }

  const items = common.map((k) => {
    const x = ra.get(k);
    const y = rb.get(k);
    const aTotal = x.total ?? 0;
    const bTotal = y.total ?? 0;
    return {
      id: k,
      a_total: x.total,
      b_total: y.total,
      delta: round(bTotal - aTotal),
      a_dims: DIMS.reduce((o, d) => ((o[d] = x[d]), o), {}),
      b_dims: DIMS.reduce((o, d) => ((o[d] = y[d]), o), {}),
      a_constraint: x.constraint,
      b_constraint: y.constraint,
      a_gate: x.gate,
      b_gate: y.gate,
      a_error: x.error,
      b_error: y.error,
    };
  });

  const aggA = aggregate(common.map((k) => ra.get(k)));
  const aggB = aggregate(common.map((k) => rb.get(k)));

  const improved = items.filter((i) => i.delta > 0.001).length;
  const worsened = items.filter((i) => i.delta < -0.001).length;
  const unchanged = items.length - improved - worsened;

  const sorted = [...items].sort((p, q) => q.delta - p.delta);

  return {
    comparable: true,
    dataset: { name: dsA.name, version: dsA.version, hash: String(dsA.content_hash).slice(0, 16) },
    rubric: { a: rubricLabel(a), b: rubricLabel(b), caveat: rubricCaveat },
    overlap: common.length,
    only_a: onlyA,
    only_b: onlyB,
    a: { ...meta(a, dsA), aggregate: aggA },
    b: { ...meta(b, dsB), aggregate: aggB },
    delta: {
      total: round(aggB.total - aggA.total),
      dims: Object.fromEntries(DIMS.map((d) => [d, round(aggB.dims[d] - aggA.dims[d])])),
    },
    summary: {
      improved,
      worsened,
      unchanged,
      best: sorted[0] ?? null,
      worst: sorted[sorted.length - 1] ?? null,
    },
    by_dimension: [
      ...DIMS.map((d) => ({
        dim: d,
        a: aggA.dims[d],
        b: aggB.dims[d],
        delta: round(aggB.dims[d] - aggA.dims[d]),
      })),
      // 约束遵循单列：它不是五维之一，不进均分，只做门禁与参考
      ...(aggA.constraint !== null || aggB.constraint !== null
        ? [{
            dim: 'constraint',
            a: aggA.constraint,
            b: aggB.constraint,
            delta: aggA.constraint !== null && aggB.constraint !== null
              ? round(aggB.constraint - aggA.constraint)
              : null,
            kind: 'constraint',
          }]
        : []),
    ],
    items,
  };
}

function meta(run, ds) {
  return {
    id: run.id,
    provider: run.provider,
    model: run.model,
    status: run.status,
    config_hash: String(run.config_hash).slice(0, 16),
    total_items: run.total_items,
    done_items: run.done_items,
    failed_items: run.failed_items,
    created_at: run.created_at,
    finished_at: run.finished_at,
    dataset: ds ? { name: ds.name, version: ds.version, hash: String(ds.content_hash).slice(0, 16) } : null,
  };
}

export { DIMS };
