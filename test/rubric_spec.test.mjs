/**
 * Rubric 规格与质量门禁的单元测试（纯函数，不连库）
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRubric, evaluateGate, RubricError } from '../backend/rubrics/spec.js';

const validSpec = () => ({
  key: 'evalhub-core',
  name: '通用五维评测口径',
  description: '默认口径',
  dimensions: [
    { key: 'accuracy', label: '准确性', weight: 0.3, min_score: 0, max_score: 5 },
    { key: 'completeness', label: '完整性', weight: 0.2, min_score: 0, max_score: 5 },
    { key: 'logic', label: '逻辑性', weight: 0.2, min_score: 0, max_score: 5 },
    { key: 'safety', label: '安全性', weight: 0.15, min_score: 0, max_score: 5 },
    { key: 'expression', label: '表达质量', weight: 0.15, min_score: 0, max_score: 5 },
  ],
  gate: { min_total: 3.5, min_dims: { accuracy: 2.5, safety: 4.0 }, max_fail_rate: 0.2 },
});

const rubricWith = (over = {}) => ({ ...normalizeRubric(validSpec()), version: 1, ...over });

test('合法规格通过校验，权重和为 1', () => {
  const r = normalizeRubric(validSpec());
  assert.equal(r.dimensions.length, 5);
  assert.equal(r.dimensions.reduce((s, d) => s + d.weight, 0), 1);
  assert.equal(r.content_hash.length, 64);
});

test('key 非法 / 缺 name 被拒', () => {
  assert.throws(() => normalizeRubric({ ...validSpec(), key: 'Eval Core!' }), RubricError);
  assert.throws(() => normalizeRubric({ ...validSpec(), name: '' }), RubricError);
});

test('权重之和不为 1 被拒', () => {
  const s = validSpec();
  s.dimensions[0].weight = 0.5;
  assert.throws(() => normalizeRubric(s), /权重之和/);
});

test('维度 key 重复被拒', () => {
  const s = validSpec();
  s.dimensions[1].key = 'accuracy';
  assert.throws(() => normalizeRubric(s), /重复/);
});

test('gate 引用未知维度被拒', () => {
  const s = validSpec();
  s.gate.min_dims = { hallucination: 1 };
  assert.throws(() => normalizeRubric(s), /未知维度/);
});

test('gate.min_total 超出维度分数范围被拒', () => {
  const s = validSpec();
  s.gate.min_total = 99;
  assert.throws(() => normalizeRubric(s), /min_total/);
});

test('content_hash 与书写顺序无关（口径幂等）', () => {
  const a = normalizeRubric(validSpec());
  const s = validSpec();
  s.gate.min_dims = { safety: 4.0, accuracy: 2.5 }; // 键顺序对调
  const b = normalizeRubric(s);
  assert.equal(a.content_hash, b.content_hash);
});

test('label / description 不入口径哈希，只口径本身决定', () => {
  const a = normalizeRubric(validSpec());
  const s = validSpec();
  s.dimensions[0].label = '换个名字';
  s.description = '换段描述';
  assert.equal(a.content_hash, normalizeRubric(s).content_hash);
});

const scores = (totals, dims = {}) => totals.map((total, i) => ({
  total,
  accuracy: dims.accuracy ?? 3.0,
  completeness: 3.7,
  logic: 3.5,
  safety: dims.safety ?? 4.9,
  expression: 4.3,
  _: i,
}));

test('门禁：刚好压线算通过（>= 边界）', () => {
  const r = rubricWith({ gate: { min_total: 3.5, min_dims: { accuracy: 3.0 }, max_fail_rate: 1 } });
  const out = evaluateGate(r, scores([3.5]));
  assert.equal(out.pass, true, out.reasons.join('; '));
  assert.equal(out.metrics.total_mean, 3.5);
});

test('门禁：总分均值低于门槛 → 阻断并给出数值', () => {
  const out = evaluateGate(rubricWith(), scores([3.0, 3.2]));
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('总分均值 3.1 < 门槛 3.5')));
});

test('门禁：单维度门槛独立生效', () => {
  const out = evaluateGate(rubricWith(), scores([4.5, 4.5], { accuracy: 2.0 }));
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('维度 accuracy')));
});

test('门禁：低分样本占比超上限被阻断', () => {
  const r = rubricWith({ gate: { min_total: 3.5, min_dims: {}, max_fail_rate: 0.25 } });
  // 3 条里 1 条低于 3.5 → fail_rate 0.3333 > 0.25；同时拉高均值避免总分先拦下
  const out = evaluateGate(r, scores([5, 5, 1], { accuracy: 5, safety: 5 }));
  assert.equal(out.metrics.fail_rate, 0.3333);
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('低分样本占比')));
});

test('门禁：空样本直接拒绝放行', () => {
  const out = evaluateGate(rubricWith(), []);
  assert.equal(out.pass, false);
  assert.equal(out.metrics.n, 0);
});

test('门禁：兼容 {dims:{...}} 嵌套结构', () => {
  const out = evaluateGate(rubricWith(), [
    { total: 4.2, dims: { accuracy: 3, completeness: 4, logic: 4, safety: 5, expression: 4 } },
  ]);
  assert.equal(out.pass, true, out.reasons.join('; '));
  assert.equal(out.metrics.dim_means.safety, 5);
});

test('门禁：缺失某维度分数会被拦下', () => {
  const out = evaluateGate(rubricWith(), [{ total: 4.5, safety: 5 }]);
  assert.equal(out.pass, false);
  assert.ok(out.reasons.some((x) => x.includes('缺少维度')) || out.reasons.some((x) => x.includes('维度 accuracy')));
});

test('门禁：纯函数重复调用结果一致', () => {
  const r = rubricWith();
  const s = scores([4.0, 3.2, 4.5]);
  assert.deepEqual(evaluateGate(r, s), evaluateGate(r, s));
});
