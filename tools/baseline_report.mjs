#!/usr/bin/env node
/**
 * EvalHub · 基线评测报告生成器
 *
 * 作用：跑一次 glm 评测任务（或读取已有 run），输出一份可直接放进简历/README 的
 *      Markdown 报告：数据集版本、模型、五维均值、按题型分组、失败明细、延迟。
 *
 * 用法：
 *   node tools/baseline_report.mjs --base http://127.0.0.1:3000 --provider glm
 *   node tools/baseline_report.mjs --run <run_id>            # 直接汇总已有任务
 *   node tools/baseline_report.mjs --compare <local_run_id>  # 与本地复算对比
 *   --token <jwt>  当后端开启 EVALHUB_AUTH 时必填
 *   --out reports/baseline_YYYYMMDD.md（默认按日期命名）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};

const BASE = opt('base', process.env.EVALHUB_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const TOKEN = opt('token', process.env.EVALHUB_TOKEN || '');
const PROVIDER = opt('provider', 'glm');
const GIVEN_RUN = opt('run');
const COMPARE = opt('compare');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const headers = { 'Content-Type': 'application/json', ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}) };

async function api(p, init = {}) {
  const r = await fetch(`${BASE}${p}`, { headers, ...init });
  const b = await r.json().catch(() => ({}));
  if (!r.ok || b.ok === false) throw new Error(`${r.status} ${b.error || '请求失败'}`);
  return b.data;
}

const DIMS = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];
const DIM_CN = { accuracy: '准确性', completeness: '完整性', logic: '逻辑性', safety: '安全性', expression: '表达质量' };

function summarize(rows) {
  const ok = rows.filter((r) => !r.error);
  const mean = (k) => (ok.length ? ok.reduce((s, r) => s + (Number(r[k]) || 0), 0) / ok.length : 0);
  const byType = {};
  for (const r of ok) {
    const t = r.task_type || '未知';
    (byType[t] ||= []).push(r);
  }
  const typeStats = Object.entries(byType).map(([t, list]) => ({
    type: t,
    n: list.length,
    total: +(list.reduce((s, r) => s + (Number(r.total) || 0), 0) / list.length).toFixed(2),
    accuracy: +(list.reduce((s, r) => s + (Number(r.accuracy) || 0), 0) / list.length).toFixed(2),
  }));
  const lat = rows.map((r) => r.latency_ms).filter((x) => typeof x === 'number').sort((a, b) => a - b);
  const p = (q) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(q * lat.length))] : null);
  return {
    n: rows.length,
    ok: ok.length,
    failed: rows.length - ok.length,
    total_mean: +(ok.reduce((s, r) => s + (Number(r.total) || 0), 0) / (ok.length || 1)).toFixed(2),
    dims: Object.fromEntries(DIMS.map((d) => [d, +mean(d).toFixed(2)])),
    typeStats: typeStats.sort((a, b) => b.total - a.total),
    latency: lat.length ? { p50: p(0.5), p90: p(0.9), max: lat[lat.length - 1] } : null,
    failures: rows.filter((r) => r.error).map((r) => `${r.id}: ${r.error}`),
  };
}

async function waitRun(id) {
  let last = -1;
  for (;;) {
    const r = await api(`/api/runs/${id}`);
    if (r.done_items !== last) {
      last = r.done_items;
      process.stdout.write(`\r  进度 ${r.done_items}/${r.total_items} 失败 ${r.failed_items}   `);
    }
    if (['succeeded', 'failed', 'canceled'].includes(r.status)) {
      process.stdout.write('\n');
      return r;
    }
    await sleep(800);
  }
}

function md({ run, s, compare, health }) {
  const d = new Date().toISOString().slice(0, 10);
  const L = [];
  L.push(`# EvalHub 基线评测报告（${d}）`, '');
  L.push('| 项 | 值 |', '|---|---|');
  L.push(`| 数据集 | ${health?.storage?.dataset ?? '-'} @v${health?.storage?.version ?? '-'} |`);
  L.push(`| 数据集内容哈希 | \`${health?.storage?.content_hash ?? '-'}\` |`);
  L.push(`| 模型 / provider | ${run.model} / ${run.provider} |`);
  L.push(`| 任务 ID | \`${run.id}\` |`);
  L.push(`| 样本数 / 有效 | ${s.n} / ${s.ok} |`);
  L.push(`| 总分均值（5 分制） | **${s.total_mean}** |`);
  if (s.latency) L.push(`| 单条延迟 p50 / p90 / max | ${s.latency.p50}ms / ${s.latency.p90}ms / ${s.latency.max}ms |`);
  L.push('');
  L.push('## 五维均值', '', '| 维度 | 均值 |', '|---|---|');
  for (const dim of DIMS) L.push(`| ${DIM_CN[dim]} | ${s.dims[dim]} |`);
  L.push('');
  L.push('## 按题型', '', '| 题型 | 条数 | 总分均值 | 准确性均值 |', '|---|---:|---:|---:|');
  for (const t of s.typeStats) L.push(`| ${t.type} | ${t.n} | ${t.total} | ${t.accuracy} |`);
  L.push('');
  if (s.failures.length) {
    L.push('## 失败条目', '');
    for (const f of s.failures.slice(0, 20)) L.push(`- ${f}`);
    L.push('');
  }
  if (compare) {
    L.push('## 与本地复算对比', '', '| 指标 | 本任务 | 对照任务 | 差值 |', '|---|---:|---:|---:|');
    L.push(`| 总分均值 | ${s.total_mean} | ${compare.total_mean} | ${(s.total_mean - compare.total_mean).toFixed(2)} |`);
    for (const dim of DIMS) {
      L.push(`| ${DIM_CN[dim]} | ${s.dims[dim]} | ${compare.dims[dim]} | ${(s.dims[dim] - compare.dims[dim]).toFixed(2)} |`);
    }
    L.push('');
  }
  L.push('## 结论口径', '');
  L.push('- 分数由 MoonBit 评测引擎按固定规则计算，同一输入可复现；温度等因素只影响模型输出本身。');
  L.push('- 本报告仅覆盖上述样本集，不外推到未见过的分布。');
  L.push('');
  return L.join('\n');
}

try {
  const health = await api('/api/health');
  let runId = GIVEN_RUN;
  if (!runId) {
    const created = await api('/api/runs', {
      method: 'POST',
      body: JSON.stringify({ provider: PROVIDER, config: { purpose: 'baseline_report' } }),
    });
    console.log(`已创建任务 ${created.id}（${created.total_items} 条，provider=${PROVIDER}）`);
    runId = created.id;
    const finished = await waitRun(runId);
    if (finished.status !== 'succeeded') {
      console.error(`任务未成功：${finished.status}`);
    }
  }

  const run = await api(`/api/runs/${runId}`);
  const { rows } = await api(`/api/runs/${runId}/results`);
  const s = summarize(rows);

  // 结果行没带 task_type，从数据集补齐
  const ds = await api('/api/dataset');
  const typeById = new Map(ds.items.map((i) => [i.id, i.task_type]));
  for (const r of rows) r.task_type = typeById.get(r.id) ?? r.task_type;
  const s2 = summarize(rows);

  let compare = null;
  if (COMPARE) {
    const crows = (await api(`/api/runs/${COMPARE}/results`)).rows;
    for (const r of crows) r.task_type = typeById.get(r.id) ?? r.task_type;
    compare = summarize(crows);
  }

  const out = opt('out', path.join(ROOT, 'reports', `baseline_${new Date().toISOString().slice(0, 10)}.md`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, md({ run, s: s2, compare, health }), 'utf8');
  console.log(`报告已写入：${path.relative(ROOT, out)}`);
  console.log(`总分均值 ${s2.total_mean}  五维 ${DIMS.map((d) => `${DIM_CN[d]}=${s2.dims[d]}`).join(' ')}`);
  process.exit(0);
} catch (e) {
  console.error('失败：', e.message);
  process.exit(1);
}
