#!/usr/bin/env node
/**
 * EvalHub · 生成「一键标注」离线页面（单文件 HTML，双击即用）
 *
 * 为什么要做：在线盲标一条要翻页 + 写理由，36 条要十几分钟，人就不想标了。
 * 这个页面把成本压到「按 A / B / T 三个键」——36 次按键，结束自动导出 CSV。
 *
 * ⚠️ 它只做「采集人的判断」，不做判断本身：
 *    - 不预选、不排序、不提示哪边"更像对的"
 *    - 不显示字数（本项目争议正是长度，显示等于给答案）
 *    - 不显示 strategy / expected_choice / split
 *    - 导出 CSV 的 choice 列由人按键产生，脚本不代填
 *
 * 用法：
 *   DATABASE_URL=... node tools/make_label_page.mjs
 * 产物：
 *   reports/label_heldout.html   双击打开 → 按键标注 → 导出 CSV
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInTenant } from '../backend/tenant/cli.js';
import { query, closePool } from '../backend/db.js';
import { tenantId } from '../backend/tenant/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// --ids L081,L082 ：只出这几条（用于复核分歧样本）。带 --review 时显示上次选择。
const ARGV = process.argv.slice(2);
const idsArg = ARGV.includes('--ids') ? ARGV[ARGV.indexOf('--ids') + 1] : null;
const REVIEW = ARGV.includes('--review');
const ONLY = idsArg ? idsArg.split(',').map((s) => s.trim()).filter(Boolean) : null;
const OUT = path.join(ROOT, ONLY ? 'reports/label_review.html' : 'reports/label_heldout.html');

async function load() {
  if (ONLY) {
    const { rows } = await query(
      `SELECT p.id, p.task_type, p.prompt, p.answer_a, p.answer_b,
              (SELECT a.choice FROM label_annotations a
                WHERE a.pair_id = p.id AND a.label_source = 'human'
                ORDER BY a.created_at DESC LIMIT 1) AS prev
         FROM label_pairs p
        WHERE p.tenant_id = $1 AND p.id = ANY($2)
        ORDER BY p.id`,
      [tenantId(), ONLY],
    );
    return rows;
  }
  const { rows } = await query(
    `SELECT p.id, p.task_type, p.prompt, p.answer_a, p.answer_b, NULL AS prev
       FROM label_pairs p
      WHERE p.split = 'test' AND p.tenant_id = $1
        AND NOT EXISTS (SELECT 1 FROM label_annotations a
                         WHERE a.pair_id = p.id AND a.label_source = 'human')
      ORDER BY p.id`,
    [tenantId()],
  );
  return rows;
}

const esc = (s) => String(s ?? '');

await runInTenant(async () => {
  const rows = await load();
  if (!rows.length) {
    console.log('没有待标注的 test 集样本');
    return;
  }

  const items = rows.map((r) => ({
    id: r.id,
    task_type: r.task_type,
    prompt: esc(r.prompt),
    a: esc(r.answer_a),
    b: esc(r.answer_b),
    prev: r.prev || '',
  }));

  // </script> 注入防护：把 < 转义成 \u003c
  const data = JSON.stringify(items).replace(/</g, '\\u003c');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>EvalHub · 留出集标注（${items.length} 条）</title>
<style>
  :root {
    --bg: #0f1115; --panel: #171a21; --panel-2: #1d2129; --line: #2a2f3a;
    --text: #e6e9ef; --text-2: #9aa4b2; --brand: #6ea8fe; --ok: #34d399;
    --warn: #fbbf24; --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; background: var(--bg); color: var(--text);
    font: 15px/1.65 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 22px 18px 90px;
  }
  .wrap { max-width: 900px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 14px; flex-wrap: wrap; }
  .bar { flex: 1; height: 6px; background: var(--panel-2); border-radius: 999px; overflow: hidden; min-width: 140px; }
  .bar > i { display: block; height: 100%; width: 0; background: var(--brand); transition: width .18s ease; }
  .meta { color: var(--text-2); font-size: 13px; font-variant-numeric: tabular-nums; }
  .tag { font-size: 12px; color: var(--brand); border: 1px solid #2b3d5c; background: #16202e;
         padding: 1px 8px; border-radius: 999px; }
  .card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 16px 18px; margin-bottom: 12px; }
  .q { font-size: 16px; font-weight: 600; margin: 2px 0 0; }
  .ans { white-space: pre-wrap; word-break: break-word; }
  .ans-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
  .key { font-family: var(--mono); font-size: 12px; font-weight: 700; width: 22px; height: 22px;
         display: grid; place-items: center; border-radius: 6px; background: #253045; color: var(--brand); }
  .hint { position: fixed; left: 0; right: 0; bottom: 0; background: #12151b; border-top: 1px solid var(--line);
          padding: 10px 18px; display: flex; gap: 18px; justify-content: center; flex-wrap: wrap; font-size: 13px; color: var(--text-2); }
  kbd { font-family: var(--mono); background: #232936; border: 1px solid #333b4b; border-bottom-width: 2px;
        border-radius: 5px; padding: 1px 6px; color: var(--text); font-size: 12px; }
  .done { text-align: center; padding: 40px 0; }
  .done h2 { margin: 0 0 6px; font-size: 22px; }
  .btns { display: flex; gap: 10px; justify-content: center; margin-top: 18px; flex-wrap: wrap; }
  button { font: inherit; padding: 10px 18px; border-radius: 9px; border: 1px solid var(--line);
           background: var(--panel-2); color: var(--text); cursor: pointer; }
  button.primary { background: #1d4ed8; border-color: #1d4ed8; color: #fff; }
  button:hover { filter: brightness(1.12); }
  table { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 16px; }
  th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid var(--line); }
  th { color: var(--text-2); font-weight: 500; }
  .muted { color: var(--text-2); }
  .note { font-size: 12.5px; color: var(--text-2); margin-top: 8px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <span class="tag" id="tag">··</span>
    <div class="bar"><i id="prog"></i></div>
    <span class="meta" id="counter">0 / ${items.length}</span>
  </header>

  <div id="app"></div>
</div>

<div class="hint">
  <span><kbd>A</kbd> 选 A</span>
  <span><kbd>B</kbd> 选 B</span>
  <span><kbd>T</kbd> 平手</span>
  <span><kbd>S</kbd> 跳过</span>
  <span><kbd>⌫</kbd> 回退</span>
  <span class="muted">只看「哪个更好地完成了题目要求」，别按长度判</span>
</div>

<script>
const ITEMS = ${data};
const KEY = 'evalhub_heldout_' + (ITEMS[0] && ITEMS[0].prev ? 'review' : 'v2');
let state = load();          // { idx, labels: { id: 'A'|'B'|'平手' } }
let idx = state.idx || 0;

function load() {
  try { return JSON.parse(localStorage.getItem(KEY)) || { idx: 0, labels: {} }; }
  catch { return { idx: 0, labels: {} }; }
}
function save() {
  state.idx = idx;
  localStorage.setItem(KEY, JSON.stringify(state));
}
function answered() { return Object.keys(state.labels).length; }

function render() {
  const app = document.getElementById('app');
  const n = ITEMS.length;
  document.getElementById('prog').style.width = ((answered() / n) * 100) + '%';
  document.getElementById('counter').textContent = answered() + ' / ' + n + ' 已标';

  if (idx >= n) {
    app.innerHTML = doneHtml();
    document.getElementById('tag').textContent = '完成';
    return;
  }
  const it = ITEMS[idx];
  document.getElementById('tag').textContent = it.task_type + ' · ' + it.id;
  app.innerHTML = \`
    <div class="card">
      <div class="ans-head"><span class="meta">题目</span>\${it.prev ? \`<span class="tag">上次标了 \${it.prev}</span>\` : ''}</div>
      <div class="q">\${it.prompt}</div>
    </div>
    <div class="card">
      <div class="ans-head"><span class="key">A</span><span class="meta">回答 A</span></div>
      <div class="ans">\${it.a}</div>
    </div>
    <div class="card">
      <div class="ans-head"><span class="key">B</span><span class="meta">回答 B</span></div>
      <div class="ans">\${it.b}</div>
    </div>\`;
}

function doneHtml() {
  const rows = ITEMS.map((it) => {
    const c = state.labels[it.id] || '';
    return \`<tr><td class="muted">\${it.id}</td><td>\${c || '<span class="muted">未标</span>'}</td></tr>\`;
  }).join('');
  const missing = ITEMS.filter((it) => !state.labels[it.id]).length;
  return \`
    <div class="done">
      <h2>标完了</h2>
      <div class="muted">共 \${ITEMS.length} 条，已标 \${ITEMS.length - missing} 条\${missing ? '，未标 ' + missing + ' 条（可导出后补）' : ''}</div>
      <div class="btns">
        <button class="primary" onclick="download()">下载 CSV</button>
        <button onclick="copyCsv(this)">复制 CSV</button>
        <button onclick="back()">回去检查</button>
        <button onclick="resetAll()">重新开始（清空）</button>
      </div>
      <div class="note">CSV 存到 <code>reports/label_sheet_heldout.csv</code> 覆盖同名文件，然后回来告诉我。</div>
      <table><thead><tr><th>id</th><th>choice</th></tr></thead><tbody>\${rows}</tbody></table>
    </div>\`;
}

function csv() {
  const lines = ['id,choice,confidence,reason'];
  for (const it of ITEMS) {
    const c = state.labels[it.id] || '';
    lines.push(it.id + ',' + c + ',,');
  }
  return lines.join('\\n') + '\\n';
}
window.download = function () {
  const blob = new Blob([csv()], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'label_sheet_heldout.csv'; a.click();
  URL.revokeObjectURL(url);
};
window.copyCsv = async function (btn) {
  try { await navigator.clipboard.writeText(csv()); btn.textContent = '已复制'; }
  catch { btn.textContent = '复制失败，请用下载'; }
};
window.back = function () { idx = Math.max(0, idx - 1); save(); render(); };
window.resetAll = function () {
  if (!confirm('清空所有已标结果？')) return;
  state = { idx: 0, labels: {} }; idx = 0; save(); render();
};

function pick(choice) {
  if (idx >= ITEMS.length) return;
  state.labels[ITEMS[idx].id] = choice;
  idx += 1; save(); render();
}

document.addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'a') pick('A');
  else if (k === 'b') pick('B');
  else if (k === 't' || k === ' ') { e.preventDefault(); pick('平手'); }
  else if (k === 's') { idx = Math.min(ITEMS.length, idx + 1); save(); render(); }
  else if (e.key === 'Backspace') { e.preventDefault(); idx = Math.max(0, idx - 1); save(); render(); }
});

render();
</script>
</body>
</html>`;

  fs.writeFileSync(OUT, html, 'utf8');
  console.log(`生成 ${items.length} 条 → ${path.relative(ROOT, OUT)}（${(Buffer.byteLength(html) / 1024).toFixed(1)} KB）`);
});

await closePool();
