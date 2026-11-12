/**
 * 约束门禁 · 契约测试
 *
 * 守的是四件事（都是「能不能拿去用」级别，不是风格问题）：
 *   1. 五维字段保持原样，新增字段只增不改 —— 历史 run 的对比不能因为改口径而失效
 *   2. 题面写明的约束能自动解析出来，不靠题目 ID 硬编码
 *   3. 违规只封顶、不改写 total —— 两个分数衡量不同东西，混在一起就没法解释
 *   4. 空答案不能因为「没超过字数上限」而被判合规
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { score } from '../backend/engine.js';

const LEGACY_DIMS = ['accuracy', 'completeness', 'logic', 'safety', 'expression', 'total'];

const P = {
  label: '判断这句话的情绪（正面/负面/中性）：「这家店的服务态度太差了，再也不会来了。」',
  cap30: '请用不超过30字概括：随着5G网络的普及，物联网设备数量激增。',
  threeSent: '用3句话写一个关于「坚持」的小故事，要有转折。',
  code: '用 Python 写一个函数，把字符串反转。',
  plain: '中国的首都是哪个城市？',
};

function s(prompt, answer, task_type = '') {
  return score({ prompt, answer, reference: '', task_type });
}

test('向后兼容：五维字段与 total 全部保留', () => {
  const r = s(P.plain, '北京', '事实问答');
  for (const d of LEGACY_DIMS) {
    assert.equal(typeof r[d], 'number', `缺字段 ${d}`);
  }
  assert.ok(r.total >= 0 && r.total <= 5);
});

test('新增字段：constraint / gate / gated_total / constraint_checks 齐备', () => {
  const r = s(P.plain, '北京', '事实问答');
  assert.equal(typeof r.constraint, 'number');
  assert.ok(['pass', 'warn', 'fail'].includes(r.gate));
  assert.equal(typeof r.gated_total, 'number');
  assert.ok(Array.isArray(r.constraint_checks));
  assert.ok(r.constraint_checks.length >= 1);
});

test('约束解析来自题面，不是题目 ID：换一道同类型题一样能判', () => {
  // 题面里没有「不超过N字」→ 不产生字数约束
  const a = s('给我讲讲唐朝的历史。', '唐朝从618年建立到907年灭亡，历时289年。');
  assert.equal(a.constraint_checks.some((c) => c.kind === 'max_chars'), false);
  // 题面里有 → 产生，且违规能抓到
  const b = s('请用不超过10字说明唐朝起止。', '唐朝从618年建立到907年灭亡，历时289年。');
  const cap = b.constraint_checks.find((c) => c.kind === 'max_chars');
  assert.ok(cap, '应当解析出字数约束');
  assert.equal(cap.ok, false);
});

test('门禁只封顶不改写：total 保持五维均分，gated_total ≤ total', () => {
  const r = s(P.cap30, '随着5G网络的普及，物联网设备的数量正在激增，智能家居和智慧城市等应用场景不断落地。', '文本摘要');
  assert.equal(r.gate, 'warn');
  assert.ok(r.gated_total <= 3.5);
  assert.ok(r.gated_total <= r.total);
  assert.ok(r.total > 0);
});

test('合规答案不被封顶：gated_total 等于 total', () => {
  const r = s(P.cap30, '5G推动万物互联，物联网应用加速落地。', '文本摘要');
  assert.equal(r.gate, 'pass');
  assert.equal(r.gated_total, r.total);
});

test('句数约束：要求 3 句只写 1 句 → 判违规', () => {
  const r = s(P.threeSent, '他坚持了四十年。', '创意写作');
  assert.equal(r.gate, 'warn');
  const c = r.constraint_checks.find((x) => x.kind === 'sentence_count');
  assert.equal(c.ok, false);
});

test('标签约束：一个都不给 → 硬约束失败；同时出现多个 → 只标待复核', () => {
  const miss = s(P.label, '这句话在抱怨服务态度。', '情感分析');
  assert.equal(miss.gate, 'warn');
  assert.equal(miss.critical_failed, 1);

  const both = s(P.label, '看似正面，其实是负面。', '情感分析');
  assert.equal(both.gate, 'pass');
  assert.ok(both.needs_review.length >= 1);
});

test('代码约束：只讲思路不写代码 → 判违规', () => {
  const r = s(P.code, '可以用切片从后往前取。', '代码生成');
  assert.equal(r.gate, 'warn');
  assert.equal(r.constraint_checks.find((c) => c.kind === 'code').ok, false);
});

test('空答案：不因「没超字数」被判合规', () => {
  const r = s(P.cap30, '', '文本摘要');
  assert.equal(r.gate, 'fail');
  assert.ok(r.gated_total <= 2.0);
  assert.equal(r.constraint_checks.find((c) => c.kind === 'non_empty').ok, false);
});

test('确定性：同一输入连跑三次结果完全一致', () => {
  const one = JSON.stringify(s(P.label, '负面', '情感分析'));
  for (let i = 0; i < 2; i++) {
    assert.equal(JSON.stringify(s(P.label, '负面', '情感分析')), one);
  }
});
