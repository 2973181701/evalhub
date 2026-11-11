/**
 * API Key 生命周期与配额的纯函数测试
 *
 * 这些边界不测就会以「线上密钥莫名失效 / 莫名可用」的形式出现，
 * 而且极难复现——过期判断涉及毫秒级比较，撤销与过期还会互相遮蔽。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isKeyUsable, retiredName, normalizeRateLimit, DEFAULT_RATE_LIMIT, ApiKeyError,
} from '../backend/apikeys.js';

const NOW = new Date('2026-11-11T08:00:00.000Z');

test('未设到期时间 → 只要没撤销就一直可用', () => {
  assert.equal(isKeyUsable({}, NOW), true);
  assert.equal(isKeyUsable({ expires_at: null }, NOW), true);
});

test('到期时间在未来 → 可用；在过去 → 不可用', () => {
  assert.equal(isKeyUsable({ expires_at: '2026-11-11T09:00:00Z' }, NOW), true);
  assert.equal(isKeyUsable({ expires_at: '2026-11-11T07:00:00Z' }, NOW), false);
});

test('恰好等于到期时刻 → 判过期（安全侧取严，避免边界抖动）', () => {
  assert.equal(isKeyUsable({ expires_at: '2026-11-11T08:00:00Z' }, NOW), false);
});

test('已撤销优先级高于未到期：撤销后即使没到期也不能用', () => {
  assert.equal(
    isKeyUsable({ revoked_at: '2026-11-11T07:00:00Z', expires_at: '2026-12-01T00:00:00Z' }, NOW),
    false,
  );
});

test('轮换后旧密钥改名带 @retired-<id>，且不破坏唯一约束语义', () => {
  assert.equal(retiredName('ci-gate', 7), 'ci-gate@retired-7');
  // 长名字要截断，否则拼上后缀会超出列的可读长度、也让日志难对齐
  const long = 'a'.repeat(60);
  const out = retiredName(long, 12);
  assert.ok(out.length <= 60, `实际长度 ${out.length}`);
  assert.ok(out.endsWith('@retired-12'));
  assert.notEqual(out, long);
});

test('配额：缺省 60；合法值取整；非法值一律拒绝而不是静默取默认', () => {
  assert.equal(normalizeRateLimit(null), DEFAULT_RATE_LIMIT);
  assert.equal(normalizeRateLimit(undefined), DEFAULT_RATE_LIMIT);
  assert.equal(normalizeRateLimit(''), DEFAULT_RATE_LIMIT);
  assert.equal(normalizeRateLimit(30), 30);
  assert.equal(normalizeRateLimit('12.9'), 12);

  for (const bad of [0, -1, 'abc', 100_001, NaN]) {
    assert.throws(() => normalizeRateLimit(bad), ApiKeyError, `应拒绝：${String(bad)}`);
  }
});
