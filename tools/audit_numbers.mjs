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

/* ---------- 汇总 ---------- */
console.log('\n' + '═'.repeat(78));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n不一致明细（文档必须改成产物值，或改产物）：');
  for (const b of bad) console.log('  · ' + b);
  process.exit(1);
}
console.log('');
console.log('结论：文档引用的所有关键数字与可复现产物**完全一致**。');
console.log('═'.repeat(78));
console.log('');
