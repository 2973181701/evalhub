/**
 * EvalHub · 数据质量执行器
 *
 * 规则存在 dq_rules 表里（口径可管），但只由服务端 seed 写入；
 * HTTP 不接受客户端自定义 SQL，且执行前强制校验 SQL 以 SELECT 开头。
 * 每次检查落 dq_runs + dq_findings，报告可复算、可看历史趋势。
 */

import crypto from 'node:crypto';
import { query, withTransaction } from '../db.js';
import { DQ_RULES } from './quality-rules.js';
import { summarizeChecks } from './metrics.js';

export class DqError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DqError';
    this.status = 422;
  }
}

export async function seedRules() {
  let inserted = 0;
  for (const r of DQ_RULES) {
    const res = await query(
      `INSERT INTO dq_rules (key, category, severity, description, check_sql, enabled)
       VALUES ($1,$2,$3,$4,$5,true)
       ON CONFLICT (key) DO UPDATE
         SET category = EXCLUDED.category,
             severity = EXCLUDED.severity,
             description = EXCLUDED.description,
             check_sql = EXCLUDED.check_sql,
             enabled = true
       RETURNING xmax::text AS xm`,
      [r.key, r.category, r.severity, r.description, r.check_sql],
    );
    // xmax = '0' 表示是 INSERT 而非 UPDATE
    if (res.rows[0]?.xm === '0') inserted += 1;
  }
  return { total: DQ_RULES.length, inserted, updated: DQ_RULES.length - inserted };
}

export async function listRules() {
  const { rows } = await query(
    'SELECT key, category, severity, description, enabled, created_at FROM dq_rules ORDER BY key',
  );
  return rows;
}

/** 执行单条规则。只跑服务端注册的 SQL，且强制 SELECT 开头 */
async function executeRule(client, rule) {
  const sql = String(rule.check_sql).trim();
  if (!/^select\b/i.test(sql)) {
    throw new DqError(`规则 ${rule.key} 的 SQL 不是 SELECT，已拒绝执行`);
  }
  if (/\b(insert|update|delete|drop|alter|truncate|create)\b/i.test(sql)) {
    throw new DqError(`规则 ${rule.key} 的 SQL 含写操作，已拒绝执行`);
  }
  const { rows } = await client.query(sql);
  const violations = Number(rows?.[0]?.violations ?? 0);
  if (!Number.isFinite(violations)) {
    throw new DqError(`规则 ${rule.key} 未返回数值型 violations`);
  }
  return {
    key: rule.key,
    category: rule.category,
    severity: rule.severity,
    description: rule.description,
    violations,
  };
}

export async function runChecks() {
  const { rows: rules } = await query(
    'SELECT key, category, severity, description, check_sql FROM dq_rules WHERE enabled ORDER BY key',
  );
  if (!rules.length) throw new DqError('没有启用的质量规则，请先执行 seedRules()');

  return withTransaction(async (client) => {
    const checks = [];
    for (const rule of rules) checks.push(await executeRule(client, rule));

    const summary = summarizeChecks(checks);
    const detail = checks.map((c) => ({
      key: c.key,
      category: c.category,
      severity: c.severity,
      violations: c.violations,
      passed: c.violations === 0,
    }));
    const contentHash = crypto
      .createHash('sha256')
      .update(JSON.stringify(detail), 'utf8')
      .digest('hex');

    const ins = await client.query(
      `INSERT INTO dq_runs (total_rules, passed, failed, warnings, score, status, content_hash, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb) RETURNING id, ran_at`,
      [
        summary.total_rules, summary.passed, summary.failed, summary.warnings,
        summary.score, summary.status, contentHash, JSON.stringify(detail),
      ],
    );
    const runId = ins.rows[0].id;

    for (const c of checks) {
      if (c.violations === 0) continue;
      await client.query(
        `INSERT INTO dq_findings (run_id, rule_key, severity, violations, message)
         VALUES ($1,$2,$3,$4,$5)`,
        [runId, c.key, c.severity, c.violations,
          `${c.description}：发现 ${c.violations} 处异常`],
      );
    }
    await client.query(
      `INSERT INTO audit_logs (actor_id, action, target, detail)
       VALUES (NULL, 'dq.run', $1, $2)`,
      [String(runId), JSON.stringify({ score: summary.score, status: summary.status })],
    );

    return {
      run_id: runId,
      ran_at: ins.rows[0].ran_at,
      ...summary,
      content_hash: contentHash.slice(0, 16),
      checks: detail,
    };
  });
}

export async function latestReport() {
  const { rows } = await query('SELECT * FROM dq_runs ORDER BY id DESC LIMIT 1');
  if (!rows.length) return null;
  const run = rows[0];
  const findings = await query(
    'SELECT rule_key, severity, violations, message FROM dq_findings WHERE run_id=$1 ORDER BY id',
    [run.id],
  );
  return {
    run_id: run.id,
    ran_at: run.ran_at,
    total_rules: run.total_rules,
    passed: run.passed,
    failed: run.failed,
    warnings: run.warnings,
    score: Number(run.score),
    status: run.status,
    content_hash: String(run.content_hash).slice(0, 16),
    findings: findings.rows,
  };
}

export async function history(limit = 10) {
  const n = Math.max(1, Math.min(100, Number(limit) || 10));
  const { rows } = await query(
    `SELECT id, ran_at, total_rules, passed, failed, warnings, score, status
       FROM dq_runs ORDER BY id DESC LIMIT $1`,
    [n],
  );
  return rows.map((r) => ({ ...r, score: Number(r.score) }));
}
