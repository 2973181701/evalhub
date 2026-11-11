/**
 * EvalHub · 治理层纯函数（零 DB / HTTP 依赖，供单测与 API 共用）
 */

export const nodeKey = (type, id) => `${type}:${String(id)}`;

/**
 * 汇总一次质量检查。
 * - critical 规则：violations=0 通过，>0 失败
 * - warning 规则：只提示，不计分、不触发阻断
 * - score = critical 通过率（0-100）
 */
export function summarizeChecks(checks = []) {
  const critical = checks.filter((c) => c.severity === 'critical');
  const failedChecks = critical.filter((c) => Number(c.violations) > 0);
  const warnings = checks.filter(
    (c) => c.severity === 'warning' && Number(c.violations) > 0,
  );

  const total = critical.length;
  const passed = total - failedChecks.length;
  const score = total === 0 ? 0 : Number(((passed / total) * 100).toFixed(2));

  let status = 'healthy';
  if (total === 0 || failedChecks.length > 0) status = 'critical';
  else if (warnings.length > 0) status = 'degraded';

  return {
    total_rules: checks.length,
    critical_rules: total,
    passed,
    failed: failedChecks.length,
    warnings: warnings.length,
    score,
    status,
    failing_keys: failedChecks.map((c) => c.key),
    warning_keys: warnings.map((c) => c.key),
  };
}

/** 从边集合构建节点表，节点按 key 去重 */
export function buildGraph(edges = []) {
  const nodes = new Map();
  const seenEdges = new Set();
  const clean = [];

  for (const e of edges) {
    const src = nodeKey(e.src_type, e.src_id);
    const dst = nodeKey(e.dst_type, e.dst_id);
    if (!nodes.has(src)) nodes.set(src, { key: src, type: e.src_type, id: String(e.src_id) });
    if (!nodes.has(dst)) nodes.set(dst, { key: dst, type: e.dst_type, id: String(e.dst_id) });
    const sig = `${src}|${dst}|${e.relation}`;
    if (!seenEdges.has(sig)) {
      seenEdges.add(sig);
      clean.push({
        src, dst,
        relation: e.relation,
        source: e.source ?? 'derived',
      });
    }
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.key.localeCompare(b.key)),
    edges: clean,
    stats: {
      node_count: nodes.size,
      edge_count: clean.length,
      relations: [...new Set(clean.map((e) => e.relation))].sort(),
    },
  };
}

/**
 * 沿血缘方向遍历。direction='downstream' 顺着 src→dst，'upstream' 反向。
 * BFS 且带 visited，保证有环时不死循环；返回带深度的节点，便于前端画层级。
 */
export function traverse(edges = [], startType, startId, direction = 'downstream') {
  const start = nodeKey(startType, startId);
  const adj = new Map();
  for (const e of edges) {
    const a = nodeKey(e.src_type, e.src_id);
    const b = nodeKey(e.dst_type, e.dst_id);
    const from = direction === 'downstream' ? a : b;
    const to = direction === 'downstream' ? b : a;
    if (!adj.has(from)) adj.set(from, []);
    adj.get(from).push({ key: to, relation: e.relation });
  }

  const visited = new Set([start]);
  const queue = [{ key: start, depth: 0, via: null }];
  const out = [];
  while (queue.length) {
    const cur = queue.shift();
    out.push(cur);
    for (const nxt of adj.get(cur.key) ?? []) {
      if (visited.has(nxt.key)) continue;
      visited.add(nxt.key);
      queue.push({ key: nxt.key, depth: cur.depth + 1, via: nxt.relation });
    }
  }
  return { start, direction, reachable: out.length - 1, nodes: out };
}
