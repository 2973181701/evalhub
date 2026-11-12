#!/usr/bin/env node
/**
 * EvalHub · 导入离线标注（回填 CSV → label_annotations）
 *
 * 写入的记录 label_source 恒为 **human** —— 这是金标准的唯一入口。
 * HTTP 路由不允许指定 label_source；本脚本虽然带 `--source` 参数，
 * 但只接受 human / test_fixture，且 test_fixture 会在评估脚本里被过滤掉，
 * 用于跑通流程的冒烟测试，不能拿来凑数。
 *
 * 校验全部复用 `submitLabel`（与在线盲标同一套规则），不在这里另写一份 ——
 * 两套校验必然漂移，最后分不清「数据坏了」还是「脚本坏了」。
 *
 * 用法：
 *   DATABASE_URL=... node tools/import_labels.mjs --file reports/label_sheet_heldout.csv --annotator chensj
 *   DATABASE_URL=... node tools/import_labels.mjs --file ... --dry-run     # 只校验不写库
 */

import fs from 'node:fs';
import path from 'node:path';
import { runInTenant } from '../backend/tenant/cli.js';
import { submitLabel, getPair } from '../backend/labeling/queue.js';
import { closePool } from '../backend/db.js';

const argv = process.argv.slice(2);
const arg = (name, def = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};

const FILE = arg('file', 'reports/label_sheet_heldout.csv');
const ANNOTATOR = arg('annotator', 'anonymous');
const SOURCE = arg('source', 'human');
const DRY = argv.includes('--dry-run');

if (!['human', 'test_fixture'].includes(SOURCE)) {
  console.error(`--source 只能是 human / test_fixture，收到 ${SOURCE}`);
  process.exit(2);
}

/** 极简 CSV 解析：本模板只有 4 列且 reason 可能带逗号/引号，按 RFC4180 处理引号 */
function parseCsv(text) {
  const rows = [];
  let field = '';
  let row = [];
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        inQuotes = false;
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else {
      field += c;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    if (row.some((x) => x.trim() !== '')) rows.push(row);
  }
  return rows;
}

/** 把各种输入写法收敛成 A / B / 平手 */
function normalizeChoice(raw) {
  const s = String(raw || '').trim();
  if (!s) return null; // 空 = 还没标，跳过
  const up = s.toUpperCase();
  if (up === 'A') return 'A';
  if (up === 'B') return 'B';
  if (s === '平手' || s === '平' || up === 'T' || up === 'TIE' || s === '=') return '平手';
  return s; // 交给 submitLabel 报错，脚本不擅自猜
}

const abs = path.isAbsolute(FILE) ? FILE : path.resolve(process.cwd(), FILE);
if (!fs.existsSync(abs)) {
  console.error(`找不到文件：${abs}\n先执行： node tools/export_label_sheet.mjs 生成模板`);
  process.exit(2);
}

const rows = parseCsv(fs.readFileSync(abs, 'utf8'));
const header = rows.shift().map((h) => h.trim());
const idx = (name) => header.indexOf(name);
for (const must of ['id', 'choice']) {
  if (idx(must) < 0) {
    console.error(`CSV 缺少必需列 ${must}，实际表头：${header.join(',')}`);
    process.exit(2);
  }
}

const filled = [];
const skipped = [];
for (const r of rows) {
  const id = (r[idx('id')] || '').trim();
  const choice = normalizeChoice(r[idx('choice')]);
  if (!id) continue;
  if (!choice) {
    skipped.push(id);
    continue;
  }
  filled.push({
    id,
    choice,
    confidence: idx('confidence') >= 0 ? (r[idx('confidence')] || '').trim() : '',
    reason: idx('reason') >= 0 ? (r[idx('reason')] || '').trim() : '',
  });
}

console.log(`文件：${path.relative(process.cwd(), abs)}`);
console.log(`可导入 ${filled.length} 条；未填 choice 跳过 ${skipped.length} 条${skipped.length ? '（' + skipped.slice(0, 6).join(',') + (skipped.length > 6 ? '…' : '') + '）' : ''}`);
if (DRY) console.log('（dry-run：只校验，不写库）');

let okCount = 0;
const errors = [];
await runInTenant(async () => {
  for (const row of filled) {
    try {
      if (DRY) {
        // dry-run 只查「id 存在 + 能读到盲标行」，不碰写路径。
        // 真正的字段校验仍然只发生在 submitLabel 里（不在脚本里复制一份）。
        const pair = await getPair(row.id);
        if (!pair) throw new Error('样本不存在');
        okCount++;
        console.log(`  ✓ ${row.id} → ${row.choice}`);
        continue;
      }
      await submitLabel({
        id: row.id,
        choice: row.choice,
        reason: row.reason || null,
        confidence: row.confidence === '' ? null : row.confidence,
        annotatorKey: ANNOTATOR,
        labelSource: SOURCE,
      });
      okCount++;
    } catch (e) {
      errors.push(`${row.id}: ${e.message}`);
    }
  }
});
await closePool();

if (errors.length) {
  console.log(`\n失败 ${errors.length} 条：`);
  for (const e of errors.slice(0, 20)) console.log('  ✗ ' + e);
}
console.log(`\n结果：成功 ${DRY ? 0 : okCount} 条 / 失败 ${errors.length} 条${DRY ? `（dry-run 校验通过 ${okCount} 条，未写入）` : ''}`);
if (SOURCE === 'human') {
  console.log('下一步：node tools/eval_judge_heldout.mjs  （算 held-out κ）');
}
process.exit(errors.length ? 1 : 0);
