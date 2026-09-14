#!/usr/bin/env node
/**
 * EvalHub · 数字审计（文档里的每个数字 vs 真实产物）
 *
 * 为什么需要这个：文档里的数字一旦和可复现产物不一致，就是「造假」——
 * 哪怕只是手抄错一位。本脚本把 README / 回传报告里引用的关键数字
 * 全部与 data/out/ 的权威产物对照，任一不符即 exit 1。
 *
 * 运行：node tools/audit_numbers.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT = path.join(ROOT, 'data', 'out');
const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const scores = read(path.join(OUT, 'scores.json'));
const report = read(path.join(OUT, 'report.json'));
const checks = read(path.join(OUT, 'annotation_check.json'));
const consistency = read(path.join(OUT, 'consistency.json'));
const solo = read(path.join(OUT, 'consistency_single_annotator.json'));
const dpo = read(path.join(OUT, 'rlhf_dpo.json'));
const annotations = read(path.join(ROOT, 'data', 'annotations.json'));

let pass = 0;
let fail = 0;
const bad = [];

function expect(label, actual, documented) {
  const ok = JSON.stringify(actual) === JSON.stringify(documented);
  if (ok) {
    pass++;
    console.log(`  ✓ ${label.padEnd(34)} = ${JSON.stringify(actual)}`);
  } else {
    fail++;
    bad.push(`${label}：产物=${JSON.stringify(actual)}，文档=${JSON.stringify(documented)}`);
    console.log(`  ✗ ${label.padEnd(34)} 产物=${JSON.stringify(actual)}  文档=${JSON.stringify(documented)}`);
  }
}

console.log('');
console.log('═'.repeat(78));
console.log('EvalHub · 数字审计（文档数字 vs 真实产物）');
console.log('═'.repeat(78));

/* ---------- 评测：五维均分 ---------- */
console.log('\n【评测引擎】20 条真实回答的五维均分');
expect('accuracy', report.dimensions.accuracy, 2.68);
expect('completeness', report.dimensions.completeness, 3.7);
expect('logic', report.dimensions.logic, 3.45);
expect('safety', report.dimensions.safety, 4.95);
expect('expression', report.dimensions.expression, 4.4);
expect('总分均分', report.total, 3.84);
expect('样本数', report.count ?? scores.length, 20);

/* ---------- 评测：分题型 ---------- */
console.log('\n【评测引擎】分题型均分');
const tt = Object.fromEntries(report.by_task_type.map((t) => [t.task_type, t.total]));
expect('事实问答', tt['事实问答'], 4.18);
expect('逻辑推理', tt['逻辑推理'], 3.83);
expect('文本摘要', tt['文本摘要'], 3.0);
expect('情感分析', tt['情感分析'], 4.43);
expect('代码生成', tt['代码生成'], 3.8);
expect('创意写作', tt['创意写作'], 3.67);

/* ---------- 标注：校验与质检 ---------- */
console.log('\n【标注引擎】20 条真实人工标注');
const validCount = checks.filter((c) => c.valid).length;
expect('校验通过数', validCount, 20);
expect('校验样本总数', checks.length, 20);
const tieCount = annotations.filter((a) => a.choice === '平手').length;
expect('平手数', tieCount, 2);
const tieRate = Number(((tieCount / annotations.length) * 100).toFixed(1));
expect('平手率（%）', tieRate, 10.0);
const avgConf = Number((annotations.reduce((s, a) => s + a.confidence, 0) / annotations.length).toFixed(1));
expect('平均置信度', avgConf, 4.4);

/* ---------- 数据引擎：RLHF 导出 ---------- */
console.log('\n【数据引擎】RLHF 偏好样本导出');
expect('输入标注数', dpo.total, 20);
expect('导出样本数', dpo.exported, 18);
expect('丢弃数', dpo.dropped, 2);
expect('丢弃明细.tie', dpo.dropped_detail.tie, 2);
expect('导出样本数 = 输入 - 丢弃', dpo.exported, dpo.total - dpo.dropped);

/* ---------- 一致性引擎 ---------- */
console.log('\n【一致性引擎】人工标注 vs 规则引擎判优');
expect('标注者数', consistency.annotators.length, 2);
expect('成对一致率', consistency.pairwise_agreement, 0.2);
expect('全票一致率', consistency.unanimous_rate, 0.2);
expect('Fleiss κ', consistency.fleiss_kappa, -0.2982);
expect('争议样本数', consistency.disputed_items.length, 16);

console.log('\n【一致性引擎】单人标注（诚实降级）');
expect('标注者数', solo.annotators.length, 1);
expect('Fleiss κ 为 null', solo.fleiss_kappa, null);
expect('给出了原因说明', solo.kappa_note.length > 0, true);

/* ---------- 运行期状态检查（不算失败，但要提醒） ---------- */
/*
 * 上面的数字全部基于「种子数据」（data/annotations.json 的 20 条）。
 * 但后端会把「运行期提交的标注」合并进来，按 id 去重、提交覆盖种子。
 * 一旦运行期文件存在，界面显示的数字就会和文档不一致（实测：置信度 4.4 → 4.35）。
 *
 * 这不是 bug，但会让人以为文档错了。所以这里显式提醒。
 * 见 docs/踩坑记录.md 坑 32。
 */
const SUBMITTED = path.join(OUT, 'annotations_submitted.json');
let runtimeDirty = false;
if (fs.existsSync(SUBMITTED)) {
  runtimeDirty = true;
  try {
    const sub = read(SUBMITTED);
    console.log('\n【运行期状态】⚠ 检测到运行期提交的标注');
    console.log(`  文件：data/out/annotations_submitted.json（${sub.length} 条：${sub.map((x) => x.id).join(', ')}）`);
    console.log('  影响：界面显示的数字会与本文档不一致（提交会覆盖同 id 的种子标注）。');
    console.log('  说明：本文档引用的数字全部基于种子数据 data/annotations.json 的 20 条。');
    console.log('  处理：删掉该文件并重启后端，界面即回到种子状态。');
    console.log('        （tools/api_verify.mjs 与 capture_screenshots.mjs 已加自动还原，不应再残留）');
  } catch (e) {
    console.log('\n【运行期状态】⚠ 运行期标注文件存在但无法解析：' + e.message);
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '═'.repeat(78));
console.log(`结果：${pass} 通过 / ${fail} 失败${runtimeDirty ? '（另有 1 项运行期状态提醒）' : ''}`);
if (fail > 0) {
  console.log('\n不一致明细（文档必须改成产物值，或改产物）：');
  for (const b of bad) console.log('  · ' + b);
  process.exit(1);
}
console.log('');
console.log('结论：文档引用的所有关键数字与可复现产物**完全一致**。');
if (!runtimeDirty) console.log('      运行期状态干净（无残留的测试提交标注）。');
console.log('═'.repeat(78));
console.log('');
