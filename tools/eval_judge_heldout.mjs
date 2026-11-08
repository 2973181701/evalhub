#!/usr/bin/env node
/**
 * EvalHub · 留出集上的 Judge 复评（数据飞轮第 3 步）
 *
 * 和 tools/judge_experiment.mjs 的区别：
 *   - 那个用 v1 的 20 条（提示词就是照着它们的错误改出来的，属 in-sample）；
 *   - 这个只用 label_pairs.split='test' 且 label_source='human' 的记录，
 *     题目来自独立题库、提示词设计过程从未看过这批标签，属 held-out。
 *
 * 三条防线：
 *   1. test 集没有真人标签就退出，不输出任何 κ —— 空数据算出来的数字比没有更糟。
 *   2. 只认 label_source='human'；test_fixture 一律排除。
 *   3. 输出「人工标签 vs 生成设计意图」的一致率作为难度诊断：
 *      若接近 100%，说明这批题太容易（一眼可判），κ 会虚高，必须在报告里标红。
 *
 * 用法：
 *   DATABASE_URL=... node tools/eval_judge_heldout.mjs
 *   DATABASE_URL=... JUDGE_MODE=hybrid node tools/eval_judge_heldout.mjs
 *   DATABASE_URL=... node tools/eval_judge_heldout.mjs --out reports/heldout_v1.md
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { goldStandard } from '../backend/labeling/queue.js';
import { cohenKappa, bootstrapKappa, intentAgreement } from '../backend/labeling/stats.js';
import { closePool } from '../backend/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
function dist(rows, key) {
  const d = {};
  for (const r of rows) d[r[key]] = (d[r[key]] ?? 0) + 1;
  return d;
}

async function main() {
  const args = process.argv.slice(2);
  const outArg = args.indexOf('--out');
  const outPath = outArg >= 0 && args[outArg + 1]
    ? path.resolve(ROOT, args[outArg + 1])
    : path.join(ROOT, 'reports', 'heldout_latest.json');

  if (!process.env.DATABASE_URL) {
    console.error('留出集评估需要 PostgreSQL：请设置 DATABASE_URL');
    process.exit(1);
  }

  const { preferPair, PROMPT_VERSION, JUDGE_MODE } = await import('../backend/judge.js');
  const gold = await goldStandard({ split: 'test', onlyHuman: true });

  if (!gold.length) {
    console.log('留出集（test）里还没有任何真人标签，本次不计算 κ。');
    console.log('请到 #labelqueue 逐条标注；标注进度可用 /api/label-queue/stats 查看。');
    console.log('注：设计意图 expected_choice 不是标签，测试夹具 test_fixture 也不会被计入。');
    const s = await import('../backend/labeling/queue.js');
    console.log('当前队列：', JSON.stringify(await s.stats()));
    await closePool();
    return;
  }

  console.log(`留出集真人标签：${gold.length} 条 | Judge 版本 ${PROMPT_VERSION} | 模式 ${JUDGE_MODE}`);
  if (gold.length < 10) {
    console.log(`⚠️ 样本仅 ${gold.length} 条（<10），下面的 κ 只能作为过程观察，不能作为结论。`);
  }

  const judged = [];
  let failed = 0;
  for (const g of gold) {
    try {
      const r = await preferPair({
        prompt: g.prompt,
        answer_A: g.answer_a,
        answer_B: g.answer_b,
        reference: g.reference ?? '',
        task_type: g.task_type,
      });
      judged.push({
        id: g.id,
        task_type: g.task_type,
        human: g.human_choice,
        judge: r.choice,
        agree: r.choice === g.human_choice,
        expected: g.expected_choice,
        expected_agree: g.human_choice === g.expected_choice,
        confidence: g.confidence,
        decided_by: r.decided_by ?? 'llm',
        reason: r.reason,
      });
    } catch (e) {
      failed += 1;
      console.warn(`  ${g.id} Judge 调用失败：${e.message}`);
    }
  }

  const stat = cohenKappa(judged);
  const ci = bootstrapKappa(judged);
  const expectedRate = intentAgreement(judged.map((r) => ({ human: r.human, expected: r.expected })));

  const result = {
    ran_at: new Date().toISOString(),
    prompt_version: PROMPT_VERSION,
    judge_mode: JUDGE_MODE,
    split: 'test',
    label_source: 'human',
    n: judged.length,
    judge_failed: failed,
    kappa: stat,
    kappa_ci95: ci,
    human_distribution: dist(judged, 'human'),
    judge_distribution: dist(judged, 'judge'),
    // 难度诊断：人工标签与设计意图的一致率。过高说明题目一眼可判，κ 会虚高。
    intent_agreement_rate: expectedRate,
    difficulty_warning: expectedRate >= 95
      ? '设计意图几乎被人工完全复现，题目可能过于简单，κ 会虚高；需引入更模糊的样本'
      : null,
    by_rule: judged.filter((r) => r.decided_by === 'rule').length,
    disagreements: judged.filter((r) => !r.agree).map((r) => ({
      id: r.id, human: r.human, judge: r.judge, reason: r.reason,
    })),
    rows: judged,
  };

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), 'utf8');

  console.log(`\n一致率 ${(stat.po * 100).toFixed(1)}%  Cohen κ = ${stat.kappa}  95% CI [${ci.lo}, ${ci.hi}]`);
  console.log('人工分布', result.human_distribution, '| Judge 分布', result.judge_distribution);
  console.log(`与设计意图一致率 ${expectedRate}%（难度诊断，不是正确率）`);
  if (result.difficulty_warning) console.log('⚠️', result.difficulty_warning);
  console.log(`分歧 ${result.disagreements.length} 条：${result.disagreements.map((d) => d.id).join(' ') || '无'}`);
  console.log(`已写入 ${outPath}`);
  await closePool();
}

main().catch(async (e) => {
  console.error('评估失败：', e);
  await closePool().catch(() => {});
  process.exit(1);
});
