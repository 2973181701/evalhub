/**
 * 确定性判优规则的单元测试
 *
 * 为什么规则层必须有测试：它替模型做决定，一旦判错就是硬伤 ——
 * 而且不会有"模型可能抽风"这种借口可以推脱。规则的边界（正好等于上限、
 * 双方都超限、题目要求说明理由）必须逐条钉死。
 *
 * 运行：node --test test/
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideByRule, charCount, resolveTie, stripDecoration } from '../backend/judge_rules.js';

const long = '这是一段很长的解释性文字。'.repeat(20); // ~280 字

test('charCount 去掉空白后再计数', () => {
  assert.equal(charCount(' 北京 '), 2);
  assert.equal(charCount('H₂O'), 3);
  assert.equal(charCount('a b\tc\n'), 3);
  assert.equal(charCount(null), 0);
});

test('枚举标签题：短标签对长解释 → 判短方', () => {
  const r = decideByRule({
    prompt: '判断这句话的情绪（正面/负面/中性）：「服务太差了。」',
    answer_A: '负面',
    answer_B: long,
  });
  assert.equal(r.choice, 'A');
  assert.equal(r.rule, 'label_enum');
});

test('枚举标签题：反过来也成立', () => {
  const r = decideByRule({
    prompt: '判断文体（记叙/说明/议论）：「春天来了。」',
    answer_A: long,
    answer_B: '说明',
  });
  assert.equal(r.choice, 'B');
});

test('枚举标签题：两方都是短标签 → 不判，交回模型', () => {
  const r = decideByRule({
    prompt: '判断情绪（正面/负面/中性）：「还行。」',
    answer_A: '中性',
    answer_B: '正面',
  });
  assert.equal(r, null);
});

test('枚举标签题：题目要求说明理由时不得按长度短路', () => {
  const r = decideByRule({
    prompt: '判断情绪（正面/负面/中性），并说明理由：「服务太差了。」',
    answer_A: '负面',
    answer_B: long,
  });
  assert.equal(r, null, '要求说明理由时长回答是被题目要求的，不能判负');
});

test('字数上限：一方超限一方合规 → 判合规方', () => {
  const r = decideByRule({
    prompt: '用 15 字以内写一句宣传语。',
    answer_A: '一杯好茶，半日清闲。', // 10 字
    answer_B: '我们家的奶茶选用高山原叶茶底当天现煮搭配手作珍珠口感层次丰富欢迎品尝。', // 34 字
  });
  assert.equal(r.choice, 'A');
  assert.equal(r.rule, 'word_limit');
});

test('字数上限：正好等于上限算合规', () => {
  const answer = '一二三四五'; // 5 字
  const r = decideByRule({
    prompt: '不超过5字。',
    answer_A: answer,
    answer_B: '一二三四五六', // 6 字，超 1 字
  });
  assert.equal(r.choice, 'A');
});

test('字数上限：两方都超限 → 不判', () => {
  const r = decideByRule({
    prompt: '不超过3字。',
    answer_A: '一二三四',
    answer_B: '一二三四五',
  });
  assert.equal(r, null);
});

test('字数上限：两方都合规 → 不判（此时比的是内容不是长度）', () => {
  const r = decideByRule({
    prompt: '不超过50字。',
    answer_A: '短一点的答案。',
    answer_B: '稍微长一点但同样合规的答案。',
  });
  assert.equal(r, null);
});

test('无约束的普通题目 → 不判', () => {
  const r = decideByRule({
    prompt: '什么是光合作用？',
    answer_A: '植物把光能转化为化学能的过程。',
    answer_B: long,
  });
  assert.equal(r, null, '题目没给形态约束时，长度差不构成判据，必须交回模型');
});

test('确定性：同一输入重复调用结果一致', () => {
  const input = {
    prompt: '判断情绪（正面/负面/中性）：「不错。」',
    answer_A: '正面',
    answer_B: long,
  };
  const a = decideByRule(input);
  const b = decideByRule(input);
  assert.deepEqual(a, b);
});

test('全角与半角括号都能识别', () => {
  const base = { answer_A: '正面', answer_B: long };
  assert.equal(decideByRule({ ...base, prompt: '判断情绪(正面/负面/中性)' }).rule, 'label_enum');
  assert.equal(decideByRule({ ...base, prompt: '判断情绪（正面/负面/中性）' }).rule, 'label_enum');
});

// ───────────── 平手兜底：只差一层无信息包装 ─────────────
// 四条用例全部来自留出集真实样本（Judge 判平手、人判了明确一方）

test('平手兜底 L083：B 是 A 加「简明地说：」前缀 → 判 A 赢', () => {
  const r = resolveTie({ answer_A: '是，由传递性可推出', answer_B: '简明地说：是，由传递性可推出。' });
  assert.equal(r.choice, 'A');
  assert.equal(r.rule, 'wrap_only');
});

test('平手兜底 L182：A 带前缀而 B 是裸内容 → 判 B 赢', () => {
  const r = resolveTie({
    answer_A: '简明地说：开源模型降低门槛，合规与成本仍是规模化障碍。',
    answer_B: '开源模型降低门槛，合规与成本仍是规模化障碍',
  });
  assert.equal(r.choice, 'B');
});

test('平手兜底 L262：标签外裹前缀 → 判裸标签赢', () => {
  const r = resolveTie({ answer_A: '简明地说：正面。', answer_B: '正面' });
  assert.equal(r.choice, 'B');
});

test('平手兜底 L381：B 裹「一般认为是「…」。」转述外壳 → 判 A 赢', () => {
  const r = resolveTie({
    answer_A: '便利店通常营业到很晚，有的甚至是 24 小时营业，为夜间出行的人提供便利。',
    answer_B: '一般认为是「便利店通常营业到很晚，有的甚至是 24 小时营业，为夜间出行的人提供便利。」。',
  });
  assert.equal(r.choice, 'A');
});

test('平手兜底不误伤：内容不同就维持平手', () => {
  assert.equal(resolveTie({ answer_A: '北京', answer_B: '上海' }), null);
  assert.equal(resolveTie({ answer_A: '北京是中国的首都，有悠久历史。', answer_B: '北京是中国的首都。' }), null);
});

test('平手兜底不误伤：承载语义的前缀（错：/对：）不算包装', () => {
  assert.equal(resolveTie({ answer_A: '错：北京', answer_B: '北京' }), null);
});

test('平手兜底不误伤：两方完全相同交给上游 identical 守卫', () => {
  assert.equal(resolveTie({ answer_A: '负面', answer_B: '负面' }), null);
});

test('stripDecoration 去引号/括号/尾标点', () => {
  assert.equal(stripDecoration('「正面」'), '正面');
  assert.equal(stripDecoration('“是，由传递性可推出。”'), '是，由传递性可推出');
  assert.equal(stripDecoration(' 北京。'), '北京');
});
