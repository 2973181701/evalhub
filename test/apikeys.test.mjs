/**
 * 服务化 API Key 的纯函数测试
 *
 * 只测不碰数据库的部分：密钥生成格式、哈希稳定性、形态识别、脱敏。
 * 「密钥能否通过校验」依赖真实库，由端到端验证覆盖（建 key → 调用 → 撤销 → 401）。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateApiKey, hashApiKey, looksLikeApiKey, maskKey, KEY_PATTERN,
} from '../backend/apikeys.js';

test('生成的密钥符合 ehk_<8位>.<secret> 形态', () => {
  const k = generateApiKey();
  assert.match(k.plain, KEY_PATTERN);
  assert.equal(k.prefix.length, 12, 'ehk_ + 8 位标识');
  assert.ok(k.plain.startsWith(`${k.prefix}.`));
  assert.ok(k.plain.length > 30, 'secret 必须够长，否则可暴力枚举');
});

test('每次都不同（避免伪随机导致密钥可预测）', () => {
  const set = new Set(Array.from({ length: 50 }, () => generateApiKey().plain));
  assert.equal(set.size, 50);
});

test('哈希稳定且不等于明文', () => {
  const k = generateApiKey();
  assert.equal(hashApiKey(k.plain), hashApiKey(k.plain));
  assert.notEqual(hashApiKey(k.plain), k.plain);
  assert.equal(hashApiKey(k.plain).length, 64, 'sha256 十六进制');
  // 差一个字符也必须完全不同（不能是前缀比较之类的实现）
  assert.notEqual(hashApiKey(k.plain.slice(0, -1) + 'x'), hashApiKey(k.plain));
});

test('形态识别：合法通过，JWT / 空值 / 残缺一律拒绝', () => {
  assert.equal(looksLikeApiKey(generateApiKey().plain), true);
  const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc';
  assert.equal(looksLikeApiKey(jwt), false, 'JWT 不能被误判成 API Key');
  for (const bad of ['', null, undefined, 'ehk_', 'ehk_12345678', 'ehk_12345678.', 'Bearer ehk_12345678.x']) {
    assert.equal(looksLikeApiKey(bad), false, `应拒绝：${bad}`);
  }
});

test('脱敏只保留前缀，永不泄漏 secret', () => {
  const k = generateApiKey();
  const masked = maskKey(k.prefix);
  assert.ok(masked.startsWith('ehk_'));
  assert.ok(!masked.includes(k.plain.split('.')[1]), '脱敏结果不得包含 secret');
  assert.ok(masked.length < k.plain.length);
});
