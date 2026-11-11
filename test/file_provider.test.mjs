/**
 * provider=file 的文件名白名单（安全边界）
 *
 * 这个值来自 HTTP 请求体并被拼进文件路径，属于典型的目录穿越入口。
 * 放单测里是因为「看起来写了正则」不等于没洞：字符集、`..`、隐藏文件、
 * 大小写扩展名都得逐条钉住。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { isSafeAnswersFile } from '../backend/jobs/runs.js';

test('正常文件名通过', () => {
  for (const ok of ['qwen_base.json', 'qwen-ft-2.json', 'a1.json', 'run_2026.11.json']) {
    assert.equal(isSafeAnswersFile(ok), true, `应接受：${ok}`);
  }
});

test('目录穿越一律拒绝', () => {
  for (const bad of ['../secret.json', '..\secret.json', '/etc/passwd.json', 'a/b.json', 'a\b.json']) {
    assert.equal(isSafeAnswersFile(bad), false, `应拒绝：${bad}`);
  }
});

test('隐藏文件、非 json、含空格、空值一律拒绝', () => {
  for (const bad of ['.hidden.json', 'x.JSON', 'qwen base.json', '', null, undefined, 'x.txt']) {
    assert.equal(isSafeAnswersFile(bad), false, `应拒绝：${String(bad)}`);
  }
});

test('超长文件名拒绝（避免溢出与奇怪的路径行为）', () => {
  assert.equal(isSafeAnswersFile(`${'a'.repeat(130)}.json`), false);
});
