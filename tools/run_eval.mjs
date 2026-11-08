#!/usr/bin/env node
/**
 * EvalHub · 命令行跑一次评测任务并等结果
 *
 * 用法：
 *   node tools/run_eval.mjs                          # 默认 local，复算基线
 *   node tools/run_eval.mjs --provider local
 *   node tools/run_eval.mjs --provider glm           # 需要 GLM_API_KEY
 *   node tools/run_eval.mjs --ids K01,K02,K03
 *   node tools/run_eval.mjs --base http://127.0.0.1:3031
 *
 * 行为：POST /api/runs → 每 500ms 轮询 → 结束后打印五维均值与逐条总分。
 * 退出码：0 成功 / 1 失败或被取消 / 2 参数或连接错误。
 */

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
};

const BASE = opt('base', process.env.EVALHUB_BASE || 'http://127.0.0.1:3000').replace(/\/$/, '');
const provider = opt('provider', 'local');
const ids = opt('ids', '') ? opt('ids', '').split(',').map((s) => s.trim()).filter(Boolean) : undefined;

async function api(path, init) {
  const r = await fetch(`${BASE}${path}`, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.ok === false) {
    throw new Error(`${r.status} ${body.error || '请求失败'}`);
  }
  return body.data;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  const run = await api('/api/runs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, ids, config: { source: 'tools/run_eval.mjs' } }),
  });
  console.log(`任务已创建 ${run.id}（${run.total_items} 条，provider=${provider}）`);

  let last = -1;
  let cur = run;
  for (;;) {
    cur = await api(`/api/runs/${run.id}`);
    if (cur.done_items !== last) {
      last = cur.done_items;
      process.stdout.write(`\r  进度 ${cur.done_items}/${cur.total_items}  失败 ${cur.failed_items}`);
    }
    if (['succeeded', 'failed', 'canceled'].includes(cur.status)) break;
    await sleep(500);
  }
  process.stdout.write('\n');

  const { rows } = await api(`/api/runs/${run.id}/results`);
  const ok = rows.filter((r) => !r.error);
  const dims = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];
  const mean = (k) =>
    ok.length ? (ok.reduce((s, r) => s + (Number(r[k]) || 0), 0) / ok.length).toFixed(2) : '-';

  console.log(`状态：${cur.status}  结果 ${rows.length} 条（有效 ${ok.length}）`);
  console.log('五维均值：' + dims.map((d) => `${d}=${mean(d)}`).join('  '));
  console.log('总分均值：' + (ok.length
    ? (ok.reduce((s, r) => s + (Number(r.total) || 0), 0) / ok.length).toFixed(2)
    : '-'));
  console.log('明细（前 5 条）：');
  for (const r of rows.slice(0, 5)) {
    console.log(`  ${r.id}  total=${r.total ?? '-'}  ${r.error ? 'ERR ' + r.error : ''}`);
  }
  process.exit(cur.status === 'succeeded' ? 0 : 1);
} catch (e) {
  console.error('失败：', e.message);
  process.exit(2);
}
