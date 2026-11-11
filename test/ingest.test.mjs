/**
 * 数据接入层单元测试（纯函数，不连库）
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  validateRows, contentHash, parseCsv, parsePayload, ALLOWED_TASK_TYPES, IngestError,
} from '../backend/governance/ingest.js';

const good = (id = 'A01') => ({
  id, task_type: '事实问答', prompt: '这是一道测试题？', reference: '参考答案',
});

test('校验：合法行全部接受，额外字段被忽略', () => {
  const r = validateRows([{ ...good(), _synthetic: true }]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejects.length, 0);
  assert.equal(r.accepted[0].id, 'A01');
  assert.equal(r.accepted[0]._synthetic, undefined);
});

test('校验：id 非法 / 重复 id 被拒', () => {
  const r = validateRows([good('bad id!'), good('A01'), good('A01')]);
  assert.equal(r.accepted.length, 1);
  assert.equal(r.rejects.length, 2);
  assert.ok(r.rejects[0].reason.includes('id 非法'));
  assert.ok(r.rejects[1].reason.includes('id 重复'));
});

test('校验：task_type 白名单外被拒', () => {
  const r = validateRows([{ ...good(), task_type: '不存在的题型' }]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejects[0].reason.includes('白名单'));
  assert.equal(ALLOWED_TASK_TYPES.length, 6);
});

test('校验：空 prompt / 超长 prompt 被拒', () => {
  const r = validateRows([
    { ...good('A1'), prompt: '   ' },
    { ...good('A2'), prompt: 'x'.repeat(2001) },
  ]);
  assert.equal(r.accepted.length, 0);
  assert.ok(r.rejects[0].reason.includes('为空'));
  assert.ok(r.rejects[1].reason.includes('2000'));
});

test('校验：非对象行被拒且原因可追溯', () => {
  const r = validateRows([null, 'string', [1, 2]]);
  assert.equal(r.rejects.length, 3);
  assert.deepEqual(r.rejects.map((x) => x.row_index), [1, 2, 3]);
});

test('contentHash：行顺序不影响哈希', () => {
  const a = [good('A01'), good('A02')];
  const b = [good('A02'), good('A01')];
  assert.equal(contentHash(validateRows(a).accepted), contentHash(validateRows(b).accepted));
});

test('contentHash：内容变化产生不同哈希', () => {
  const a = validateRows([good()]).accepted;
  const b = validateRows([{ ...good(), reference: '换个答案' }]).accepted;
  assert.notEqual(contentHash(a), contentHash(b));
});

test('contentHash：额外字段不入口径哈希', () => {
  const a = validateRows([good()]).accepted;
  const b = validateRows([{ ...good(), _synthetic: true }]).accepted;
  assert.equal(contentHash(a), contentHash(b));
});

test('CSV：基本解析与表头映射', () => {
  const rows = parseCsv('id,task_type,prompt,reference\nA01,事实问答,题目一,答案一\nA02,逻辑推理,题目二,答案二');
  assert.equal(rows.length, 2);
  assert.equal(rows[1].task_type, '逻辑推理');
});

test('CSV：双引号包裹含逗号的字段', () => {
  const rows = parseCsv('id,task_type,prompt,reference\nA01,事实问答,"题目,含逗号","答案""带引号"""');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prompt, '题目,含逗号');
  assert.equal(rows[0].reference, '答案"带引号"');
});

test('CSV：列数与表头不一致直接报错', () => {
  assert.throws(() => parseCsv('id,task_type,prompt\nA01,事实问答'), IngestError);
});

test('parsePayload：JSON 顶层必须是数组', () => {
  assert.throws(() => parsePayload('{"id":"A01"}', 'json'), IngestError);
  assert.throws(() => parsePayload('not json', 'json'), IngestError);
  assert.equal(parsePayload('[{"id":"A01"}]', 'json').length, 1);
});

test('parsePayload：不支持的来源类型被拒', () => {
  assert.throws(() => parsePayload('x', 'xml'), IngestError);
});
