#!/usr/bin/env node
/**
 * Judge 提示词对照实验
 *
 * 用法：
 *   JUDGE_PROMPT=v2 node tools/judge_experiment.mjs
 *   JUDGE_PROMPT=v3 node tools/judge_experiment.mjs
 *
 * 为什么不用 HTTP 接口跑实验：接口只返回汇总，做对照实验需要逐条明细、
 * 需要固定 prompt 版本、需要把结果落盘可复算。直接调用模块更可控。
 *
 * 评估口径：
 *   - 金标准 = data/annotations.json 里的人工标注（20 条 A/B 偏好）
 *   - 指标 = 一致率 + Cohen's κ（三分类 A/B/平手），κ 扣掉随机一致的部分，
 *     是判断"能不能替代人"的必要条件（业界常用门槛 κ ≥ 0.6）
 *   - 额外统计「与人工分歧的题号」，因为只看 κ 不知道该往哪改
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data');
const OUT_DIR = join(ROOT, 'reports');

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));
const CATS = ['A', 'B', '平手'];

function cohenKappa(pairs) {
  const n = pairs.length;
  if (!n) return { n: 0, po: 0, pe: 0, kappa: null };
  const po = pairs.filter((p) => p.human === p.judge).length / n;
  let pe = 0;
  for (const c of CATS) {
    const pa = pairs.filter((p) => p.human === c).length / n;
    const pb = pairs.filter((p) => p.judge === c).length / n;
    pe += pa * pb;
  }
  const kappa = pe === 1 ? null : (po - pe) / (1 - pe);
  return {
    n,
    po: Number(po.toFixed(4)),
    pe: Number(pe.toFixed(4)),
    kappa: kappa === null ? null : Number(kappa.toFixed(4)),
  };
}

function distribution(list) {
  const d = Object.fromEntries(CATS.map((c) => [c, 0]));
  for (const x of list) d[x] = (d[x] ?? 0) + 1;
  return d;
}

/**
 * Bootstrap 95% 置信区间。
 *
 * 20 条样本上的 κ 极不稳定：观测到 0.47 和 0.32 的差别，可能只是抽样波动。
 * 不给区间就宣称"改了提示词变好了"，是把噪声当结论。这里按题重采样 2000 次，
 * 取 2.5% 与 97.5% 分位。
 */
function bootstrapKappa(pairs, iterations = 2000) {
  if (pairs.length < 3) return { lo: null, hi: null, iterations: 0 };
  let seed = 20261108;
  const rand = () => {
    // 固定种子，保证结果可复现
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const samples = [];
  for (let i = 0; i < iterations; i += 1) {
    const draw = [];
    for (let j = 0; j < pairs.length; j += 1) {
      draw.push(pairs[Math.floor(rand() * pairs.length)]);
    }
    const k = cohenKappa(draw).kappa;
    if (k !== null && Number.isFinite(k)) samples.push(k);
  }
  if (!samples.length) return { lo: null, hi: null, iterations: 0 };
  samples.sort((a, b) => a - b);
  const at = (p) => samples[Math.min(samples.length - 1, Math.max(0, Math.floor(p * samples.length)))];
  return {
    lo: Number(at(0.025).toFixed(4)),
    hi: Number(at(0.975).toFixed(4)),
    iterations: samples.length,
  };
}

async function main() {
  const mode = ['two', 'hybrid'].includes(process.env.JUDGE_MODE) ? process.env.JUDGE_MODE : 'single';
  const version = process.env.JUDGE_PROMPT || 'v4';
  process.env.JUDGE_PROMPT = version;
  process.env.JUDGE_MODE = mode;
  // 文件名标签：两步版单独一个，避免覆盖单步结果
  const label = mode === 'two' ? 'v6two' : mode === 'hybrid' ? 'hybrid' : version;

  const pairs = readJson(join(DATA, 'pairs.json'));
  const human = new Map(readJson(join(DATA, 'annotations.json')).map((a) => [a.id, a]));

  // 动态 import 放在设置 env 之后：judge.js 在模块加载时读 JUDGE_PROMPT
  const { preferPair, cacheStats } = await import('../backend/judge.js');
  const { glmReady } = await import('../backend/glm.js');
  if (!glmReady) {
    console.error('未配置 GLM 密钥，无法运行实验');
    process.exit(1);
  }

  const modeCn = { two: 'v6 两步调用', hybrid: 'hybrid 规则+模型', single: version }[mode];
  console.log(`提示词版本：${modeCn}    样本：${pairs.length} 条`);
  const rows = [];
  let ok = 0;
  let cached = 0;

  for (const p of pairs) {
    const humanChoice = human.get(p.id)?.choice;
    if (!humanChoice) continue;
    process.stdout.write(`\r  判定 ${ok + 1}/${pairs.length}  ${p.id}    `);
    try {
      const r = await preferPair({
        prompt: p.prompt,
        answer_A: p.answer_A,
        answer_B: p.answer_B,
        reference: p.reference ?? '',
        task_type: p.task_type,
        useCache: true,
      });
      ok += 1;
      if (r.cached) cached += 1;
      rows.push({
        id: p.id,
        task_type: p.task_type,
        len_A: p.answer_A.length,
        len_B: p.answer_B.length,
        human: humanChoice,
        judge: r.choice,
        agree: r.choice === humanChoice,
        reason: r.reason,
        constraint: r.constraint,
        analysis: r.analysis,
        self_answer: r.self_answer,
        identical: r.identical ?? false,
        solved_answer: r.solved_answer ?? null,
        solved_determinate: r.solved_determinate ?? null,
        decided_by: r.decided_by ?? 'llm',
        rule: r.rule ?? null,
      });
    } catch (e) {
      rows.push({ id: p.id, human: humanChoice, judge: null, error: e.message });
    }
  }
  process.stdout.write('\n');

  const valid = rows.filter((r) => !r.error && r.judge);
  const stat = cohenKappa(valid);
  const wrong = valid.filter((r) => !r.agree);
  const statLong = valid.filter((r) => r.len_B > r.len_A);
  const pickedLong = statLong.filter((r) => r.judge === 'B').length;
  const humanPickedLong = statLong.filter((r) => r.human === 'B').length;

  const determinateRows = valid.filter((r) => r.solved_determinate === true);
  const byRule = valid.filter((r) => r.decided_by === 'rule');
  const result = {
    version: label,
    mode,
    prompt_version: valid[0]?.prompt_version ?? (mode === 'two' ? 'prefer-v6two' : `prefer-${version}`),
    decide_stats: {
      by_rule: byRule.length,
      by_llm: valid.length - byRule.length,
      rule_rate: valid.length ? Number(((byRule.length / valid.length) * 100).toFixed(1)) : 0,
      // 规则替模型做掉的那部分，各自对不对 —— 规则错一条就是硬伤，必须单独看
      rule_correct: byRule.filter((r) => r.agree).length,
    },
    solve_stats: mode === 'two'
      ? {
        determinate: determinateRows.length,
        indeterminate: valid.length - determinateRows.length,
        determinate_rate: valid.length ? Number(((determinateRows.length / valid.length) * 100).toFixed(1)) : 0,
      }
      : null,
    ran_at: new Date().toISOString(),
    model: process.env.GLM_MODEL || 'glm-4-flash',
    n: valid.length,
    failed: rows.length - valid.length,
    cached_hits: cached,
    kappa: stat,
    kappa_ci95: bootstrapKappa(valid),
    judge_distribution: distribution(valid.map((r) => r.judge)),
    human_distribution: distribution(valid.map((r) => r.human)),
    // 长度偏好量化：在「B 更长」的样本里，Judge 有多大比例选了更长的 B
    length_bias: {
      n_b_longer: statLong.length,
      judge_picked_b: pickedLong,
      judge_rate: statLong.length ? Number(((pickedLong / statLong.length) * 100).toFixed(1)) : 0,
      human_picked_b: humanPickedLong,
      human_rate: statLong.length ? Number(((humanPickedLong / statLong.length) * 100).toFixed(1)) : 0,
    },
    disagreements: wrong.map((r) => ({
      id: r.id,
      human: r.human,
      judge: r.judge,
      len_A: r.len_A,
      len_B: r.len_B,
      reason: r.reason,
      constraint: r.constraint,
    })),
    rows,
    cache_stats: cacheStats(),
  };

  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `judge_exp_${label}.json`);
  writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`结果 ${valid.length}/${rows.length} 条有效，失败 ${rows.length - valid.length}，缓存命中 ${cached}`);
  console.log(`一致率 ${(stat.po * 100).toFixed(1)}%   期望一致 ${(stat.pe * 100).toFixed(1)}%   Cohen κ = ${stat.kappa}`);
  console.log(`κ 的 bootstrap 95% CI = [${result.kappa_ci95.lo}, ${result.kappa_ci95.hi}]（${result.kappa_ci95.iterations} 次重采样）`);
  console.log(`Judge 分布`, result.judge_distribution, ' 人工分布', result.human_distribution);
  console.log(`长度偏好：B 更长的 ${result.length_bias.n_b_longer} 条中，Judge 选 B ${result.length_bias.judge_rate}%，人工选 B ${result.length_bias.human_rate}%`);
  console.log(`分歧题 ${wrong.length} 条：${wrong.map((r) => `${r.id}(人${r.human}/J${r.judge})`).join(' ')}`);
  console.log(`已写入 ${outPath}`);
}

main().catch((e) => {
  console.error('实验失败：', e);
  process.exit(1);
});
