/**
 * 数据中台治理层单元测试（纯函数 + 规则定义校验，不连库）
 * 运行：npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeChecks, buildGraph, traverse, nodeKey } from '../backend/governance/metrics.js';
import { DQ_RULES } from '../backend/governance/quality-rules.js';

const check = (key, severity, violations) => ({ key, severity, violations });

test('质量汇总：全部通过 → healthy，分数 100', () => {
  const s = summarizeChecks([check('a', 'critical', 0), check('b', 'critical', 0)]);
  assert.equal(s.status, 'healthy');
  assert.equal(s.score, 100);
  assert.equal(s.failed, 0);
});

test('质量汇总：critical 失败 → status=critical，分数按通过率算', () => {
  const s = summarizeChecks([
    check('a', 'critical', 0), check('b', 'critical', 3),
    check('c', 'critical', 0), check('d', 'critical', 0),
  ]);
  assert.equal(s.status, 'critical');
  assert.equal(s.score, 75);
  assert.deepEqual(s.failing_keys, ['b']);
});

test('质量汇总：warning 只降级不计分', () => {
  const s = summarizeChecks([
    check('a', 'critical', 0), check('w1', 'warning', 1),
  ]);
  assert.equal(s.status, 'degraded');
  assert.equal(s.score, 100);
  assert.equal(s.warnings, 1);
  assert.equal(s.failed, 0);
});

test('质量汇总：critical 与 warning 同时命中 → critical 优先', () => {
  const s = summarizeChecks([check('a', 'critical', 1), check('w', 'warning', 1)]);
  assert.equal(s.status, 'critical');
  assert.equal(s.failed, 1);
});

test('质量汇总：没有 critical 规则视为不可评估，而不是满分', () => {
  const s = summarizeChecks([check('w', 'warning', 0)]);
  assert.equal(s.score, 0);
  assert.equal(s.status, 'critical');
});

test('质量汇总：空输入不给满分', () => {
  assert.equal(summarizeChecks([]).score, 0);
});

test('规则集：key 唯一、severity 合法、SQL 均为 SELECT', () => {
  const keys = DQ_RULES.map((r) => r.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const r of DQ_RULES) {
    assert.ok(['critical', 'warning'].includes(r.severity), r.key);
    assert.ok(/^select\b/i.test(r.check_sql.trim()), `${r.key} 必须是 SELECT`);
    assert.ok(!/\b(insert|update|delete|drop|alter|truncate)\b/i.test(r.check_sql), `${r.key} 不得含写操作`);
    assert.ok(r.description && r.category, r.key);
  }
});

test('规则集包含三条防回归红线', () => {
  const keys = new Set(DQ_RULES.map((r) => r.key));
  for (const k of ['run_progress_bounds', 'label_split_leakage', 'annotations_choice_enum']) {
    assert.ok(keys.has(k), `缺少规则 ${k}`);
  }
});

const EDGES = [
  { src_type: 'dataset', src_id: 'core@v1', dst_type: 'run', dst_id: 'r1', relation: 'used_by' },
  { src_type: 'run', src_id: 'r1', dst_type: 'result_set', dst_id: 'r1', relation: 'produces' },
  { src_type: 'external_file', src_id: 'prompts.json', dst_type: 'label_batch', dst_id: 'queue-v1', relation: 'ingested_into' },
];

test('构图：节点去重、边去重、统计正确', () => {
  const g = buildGraph([...EDGES, { ...EDGES[0] }]);
  assert.equal(g.edges.length, 3);
  // dataset:core@v1 / run:r1 / result_set:r1 / external_file:prompts.json / label_batch:queue-v1
  // run:r1 被两条边复用，所以是 5 个节点，不是 6 个
  assert.equal(g.stats.node_count, 5);
  assert.ok(g.nodes.some((n) => n.key === nodeKey('dataset', 'core@v1')));
  assert.ok(g.stats.relations.includes('produces'));
});

test('血缘下游：dataset → run → result_set', () => {
  const out = traverse(EDGES, 'dataset', 'core@v1', 'downstream');
  assert.equal(out.reachable, 2);
  assert.deepEqual(out.nodes.map((n) => n.key), [
    'dataset:core@v1', 'run:r1', 'result_set:r1',
  ]);
  assert.equal(out.nodes[2].depth, 2);
});

test('血缘上游：result_set → run → dataset', () => {
  const out = traverse(EDGES, 'result_set', 'r1', 'upstream');
  assert.equal(out.reachable, 2);
  assert.equal(out.nodes[out.nodes.length - 1].key, 'dataset:core@v1');
});

test('血缘遍历：有环不死循环', () => {
  const cyc = [
    { src_type: 'x', src_id: 'a', dst_type: 'x', dst_id: 'b', relation: 'r' },
    { src_type: 'x', src_id: 'b', dst_type: 'x', dst_id: 'a', relation: 'r' },
  ];
  const out = traverse(cyc, 'x', 'a', 'downstream');
  assert.equal(out.reachable, 1);
  assert.equal(out.nodes.length, 2);
});

test('血缘遍历：起点不在图中也能返回自身', () => {
  const out = traverse(EDGES, 'unknown', 'zzz', 'downstream');
  assert.equal(out.reachable, 0);
  assert.equal(out.nodes[0].key, 'unknown:zzz');
});
