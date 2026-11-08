/**
 * 标注一致性统计的单元测试
 *
 * κ 是整个实验报告里最关键的数字，它的算法必须被钉死：
 * 完全一致 κ=1、永远选同一类 κ=0、反向一致 κ<0、类别不平衡时 κ 会低于原始一致率。
 *
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { cohenKappa, bootstrapKappa, intentAgreement } from '../backend/labeling/stats.js';

const rows = (pairs) => pairs.map(([human, judge]) => ({ human, judge }));

test('完全一致 → κ = 1', () => {
  const k = cohenKappa(rows([['A', 'A'], ['B', 'B'], ['平手', '平手'], ['A', 'A']]));
  assert.equal(k.kappa, 1);
  assert.equal(k.po, 1);
});

test('永远选 A 在类别不平衡数据上：一致率高但 κ = 0', () => {
  // 人工 4 个 A、1 个 B；Judge 全选 A → 一致率 80%，但完全是猜多数类
  const k = cohenKappa(rows([['A', 'A'], ['A', 'A'], ['A', 'A'], ['A', 'A'], ['B', 'A']]));
  assert.equal(k.po, 0.8);
  assert.ok(Math.abs(k.kappa) < 1e-9, `期望 κ≈0，得到 ${k.kappa}`);
});

test('系统性反向判断 → κ < 0', () => {
  const k = cohenKappa(rows([['A', 'B'], ['A', 'B'], ['B', 'A'], ['B', 'A']]));
  assert.ok(k.kappa < 0, `期望 κ<0，得到 ${k.kappa}`);
});

test('空数据 → κ = null，不返回 NaN', () => {
  const k = cohenKappa([]);
  assert.equal(k.kappa, null);
  assert.equal(k.n, 0);
});

test('两方分布完全一致但判断独立 → κ 接近 0', () => {
  const k = cohenKappa(rows([
    ['A', 'A'], ['A', 'B'], ['B', 'A'], ['B', 'B'],
    ['平手', '平手'], ['平手', 'A'],
  ]));
  assert.ok(Math.abs(k.kappa) < 0.3, `期望接近 0，得到 ${k.kappa}`);
});

test('边缘分布退化（双方全选同一类）时 κ 未定义，必须返回 null 而不是 NaN', () => {
  const k = cohenKappa(rows(Array.from({ length: 6 }, () => ['A', 'A'])));
  assert.equal(k.po, 1);
  assert.equal(k.pe, 1);
  assert.equal(k.kappa, null);
});

test('bootstrap：三类齐全且完全一致时，κ=1 且区间收缩到 1', () => {
  const data = rows([
    ['A', 'A'], ['A', 'A'], ['B', 'B'], ['B', 'B'],
    ['平手', '平手'], ['平手', '平手'],
  ]);
  assert.equal(cohenKappa(data).kappa, 1);
  const ci = bootstrapKappa(data, 300);
  assert.equal(ci.lo, 1);
  assert.equal(ci.hi, 1);
});

test('bootstrap：固定种子可复现', () => {
  const data = rows([['A', 'A'], ['B', 'B'], ['A', 'B'], ['平手', 'A'], ['B', 'B'], ['A', 'A']]);
  assert.deepEqual(bootstrapKappa(data, 200), bootstrapKappa(data, 200));
});

test('bootstrap：样本 < 3 时不给区间', () => {
  assert.deepEqual(bootstrapKappa(rows([['A', 'A']])), { lo: null, hi: null, iterations: 0 });
});

test('意图一致率：用于诊断数据是否过于简单', () => {
  assert.equal(intentAgreement([{ human: 'A', expected: 'A' }, { human: 'B', expected: 'A' }]), 50);
  assert.equal(intentAgreement([]), 0);
});
