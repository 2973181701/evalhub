/**
 * EvalHub · 标注一致性统计（纯函数，供评估脚本与单元测试共用）
 *
 * 单独成模块的原因：κ 是整份报告里最关键的一个数字，
 * 它的计算逻辑必须能被单测钉死，不能只活在一次性脚本里。
 */

export const CHOICE_CATS = ['A', 'B', '平手'];

/** Cohen's κ：扣除随机一致后的一致性。rows 里每行需有 human 与 judge 两个字段 */
export function cohenKappa(rows) {
  const n = rows.length;
  if (!n) return { n: 0, po: 0, pe: 0, kappa: null };
  const po = rows.filter((r) => r.human === r.judge).length / n;
  let pe = 0;
  for (const c of CHOICE_CATS) {
    const pa = rows.filter((r) => r.human === c).length / n;
    const pb = rows.filter((r) => r.judge === c).length / n;
    pe += pa * pb;
  }
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  return { n, po: Number(po.toFixed(4)), pe: Number(pe.toFixed(4)), kappa: kappa === null ? null : Number(kappa.toFixed(4)) };
}

/**
 * Bootstrap 置信区间。固定随机种子，保证同一批数据重跑得到同一个区间。
 * 样本少于 3 条时不给区间 —— 2 条数据算出来的 CI 没有意义。
 */
export function bootstrapKappa(rows, iterations = 2000, seed0 = 20261108) {
  if (rows.length < 3) return { lo: null, hi: null, iterations: 0 };
  let seed = seed0;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const ks = [];
  for (let i = 0; i < iterations; i += 1) {
    const draw = [];
    for (let j = 0; j < rows.length; j += 1) draw.push(rows[Math.floor(rand() * rows.length)]);
    const k = cohenKappa(draw).kappa;
    if (k !== null && Number.isFinite(k)) ks.push(k);
  }
  if (!ks.length) return { lo: null, hi: null, iterations: 0 };
  ks.sort((a, b) => a - b);
  return {
    lo: Number(ks[Math.floor(0.025 * ks.length)].toFixed(4)),
    hi: Number(ks[Math.floor(0.975 * ks.length)].toFixed(4)),
    iterations: ks.length,
  };
}

/** 人工标签与生成设计意图的一致率：用于诊断数据是否过于简单（接近 100% = 一眼可判） */
export function intentAgreement(rows) {
  if (!rows.length) return 0;
  return Number(((rows.filter((r) => r.human === r.expected).length / rows.length) * 100).toFixed(1));
}
