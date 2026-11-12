#!/usr/bin/env node
/**
 * 约束门禁回测：拿已有的回答文件，按新口径重新打分，输出可直接引用的对比数据。
 *
 * 目的：验证「约束遵循」这一维到底改变了什么。它回答三个问题——
 *   1. 两个模型各自违反了几条题面约束（谁在「守约束」上更强）
 *   2. 门禁封顶后，总分排序有没有变化（如果没变，也要如实说没变）
 *   3. 约束分与答案长度的相关性（对比五维总分与长度的相关性，验证长度偏置是否被消除）
 *
 * 用法：node tools/rescore_constraints.mjs [--out training/out/rescore.json]
 * 只读回答文件与 prompts.json，不联网、不调用模型。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, ENGINE_BUILD } from '../backend/engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? path.resolve(argv[outArg + 1]) : path.join(ROOT, 'training/out/rescore.json');

const prompts = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompts.json'), 'utf8'));
const byId = new Map(prompts.map((p) => [p.id, p]));

const FILES = ['qwen_base.json', 'qwen_ft.json'];

function pearson(xs, ys) {
  const n = xs.length;
  if (n === 0) return 0;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    const a = xs[i] - mx, b = ys[i] - my;
    num += a * b; dx += a * a; dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);
const r2 = (x) => Math.round(x * 100) / 100;

const results = [];
for (const f of FILES) {
  const payload = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/answers', f), 'utf8'));
  const rows = [];
  for (const a of payload.answers) {
    const p = byId.get(a.id);
    if (!p) continue;
    const s = score({
      prompt: p.prompt,
      answer: a.answer,
      reference: p.reference || '',
      task_type: p.task_type || '',
    });
    rows.push({
      id: a.id,
      task_type: p.task_type,
      len: String(a.answer || '').length,
      total: s.total,
      constraint: s.constraint,
      gated_total: s.gated_total,
      gate: s.gate,
      critical_failed: s.critical_failed,
      failed: (s.constraint_checks || []).filter((c) => !c.ok).map((c) => c.kind + ':' + c.detail),
    });
  }
  const gated = rows.filter((r) => r.gate !== 'pass');
  results.push({
    file: f,
    model: payload.model,
    adapter: payload.adapter || null,
    n: rows.length,
    total: r2(mean(rows.map((r) => r.total))),
    constraint: r2(mean(rows.map((r) => r.constraint))),
    gated_total: r2(mean(rows.map((r) => r.gated_total))),
    gate_counts: {
      pass: rows.filter((r) => r.gate === 'pass').length,
      warn: rows.filter((r) => r.gate === 'warn').length,
      fail: rows.filter((r) => r.gate === 'fail').length,
    },
    violations: gated.map((r) => ({ id: r.id, gate: r.gate, failed: r.failed })),
    r_len_total: r2(pearson(rows.map((r) => r.len), rows.map((r) => r.total))),
    r_len_constraint: r2(pearson(rows.map((r) => r.len), rows.map((r) => r.constraint))),
    r_len_gated: r2(pearson(rows.map((r) => r.len), rows.map((r) => r.gated_total))),
    rows,
  });
}

// 两个模型合在一起的相关性（40 条），用于和旧报告里的 r=+0.196 直接对比
const all = results.flatMap((r) => r.rows);
const pooled = {
  n: all.length,
  r_len_total: r2(pearson(all.map((r) => r.len), all.map((r) => r.total))),
  r_len_constraint: r2(pearson(all.map((r) => r.len), all.map((r) => r.constraint))),
  r_len_gated: r2(pearson(all.map((r) => r.len), all.map((r) => r.gated_total))),
};

console.log('引擎产物：' + ENGINE_BUILD);
console.log('');
console.log('文件'.padEnd(18) + '样本'.padStart(5) + 'total'.padStart(8) + '约束分'.padStart(8) + '门禁后'.padStart(8) + '  pass/warn/fail');
for (const r of results) {
  const g = r.gate_counts;
  console.log(
    r.file.padEnd(18) +
      String(r.n).padStart(5) +
      r.total.toFixed(2).padStart(8) +
      r.constraint.toFixed(2).padStart(8) +
      r.gated_total.toFixed(2).padStart(8) +
      `  ${g.pass}/${g.warn}/${g.fail}`,
  );
}
console.log('');
console.log('长度相关性（皮尔逊 r，n=' + pooled.n + '）');
console.log('  长度 vs 五维总分    r = ' + pooled.r_len_total.toFixed(3) + '   ← 旧口径，正是它奖励啰嗦');
console.log('  长度 vs 约束分      r = ' + pooled.r_len_constraint.toFixed(3));
console.log('  长度 vs 门禁后总分  r = ' + pooled.r_len_gated.toFixed(3));
console.log('');
for (const r of results) {
  if (!r.violations.length) {
    console.log(r.file + '：无门禁违规');
    continue;
  }
  console.log(r.file + '：' + r.violations.length + ' 条违规');
  for (const v of r.violations) {
    console.log('  ' + v.id + ' [' + v.gate + '] ' + v.failed.join(' ; '));
  }
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify({ generated_at: new Date().toISOString(), engine: ENGINE_BUILD, pooled, results }, null, 2), 'utf8');
console.log('\n已写入 ' + path.relative(ROOT, OUT));
