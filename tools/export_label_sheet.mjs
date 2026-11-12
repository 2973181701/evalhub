#!/usr/bin/env node
/**
 * EvalHub · 导出留出集标注清单（离线批量标注用）
 *
 * 为什么需要：在线盲标界面一次一条、要写理由，标 36 条要来回翻页。
 * 离线清单让人一口气看完再判，回填一个 CSV 即可。
 *
 * 三条不可退让的约定：
 *   1. **只导出 split='test'** —— 留出集的 κ 才有意义；训练集标注另走在线流程。
 *   2. **不导出 expected_choice / strategy_a / strategy_b** —— 这三个字段会暴露
 *      生成时的设计意图，把标注者锚定到「预期答案」。查询里显式列白名单。
 *   3. **不显示字数** —— 本项目的核心争议正是「短答案是不是更好」，
 *      标上字数等于提前给答案。要看长度自己数，或标完再看。
 *
 * 用法：
 *   DATABASE_URL=... node tools/export_label_sheet.mjs            # 待标注的 test 集
 *   DATABASE_URL=... node tools/export_label_sheet.mjs --all      # 含已标的（复盘用）
 * 产物：
 *   reports/label_sheet_heldout.md    人看的清单
 *   reports/label_sheet_heldout.csv   机器读的回填模板
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInTenant } from '../backend/tenant/cli.js';
import { query, closePool } from '../backend/db.js';
import { tenantId } from '../backend/tenant/context.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ALL = process.argv.includes('--all');
const OUT_MD = path.join(ROOT, 'reports/label_sheet_heldout.md');
const OUT_CSV = path.join(ROOT, 'reports/label_sheet_heldout.csv');

async function load() {
  // 白名单列：故意不含 expected_choice / strategy_* / split 以外的任何设计信息
  const sql = `
    SELECT p.id, p.task_type, p.prompt, p.answer_a, p.answer_b,
           EXISTS (SELECT 1 FROM label_annotations a
                    WHERE a.pair_id = p.id AND a.label_source = 'human') AS labeled
      FROM label_pairs p
     WHERE p.split = 'test' AND p.tenant_id = $1
     ${ALL ? '' : "AND NOT EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id = p.id AND a.label_source = 'human')"}
     ORDER BY p.id`;
  const { rows } = await query(sql, [tenantId()]);
  return rows;
}

function md(rows) {
  const L = [];
  L.push('# 留出集标注清单（held-out · 36 条）', '');
  L.push('> 用途：算出 **held-out κ** —— 判断 Judge 到底能不能替代人工。');
  L.push('> 规则：只看「哪个回答更好地完成了题目要求」，不看长度、不看格式漂亮与否。');
  L.push('> 确实分不出高下就填 `平手`，不要硬选。**平手是有信息量的答案。**', '');
  L.push('回填方式：编辑 `reports/label_sheet_heldout.csv`，把 `choice` 列填成 `A` / `B` / `平手`，');
  L.push('`confidence` 填 1–5（1=猜的，5=很确定），`reason` 写几个字（为什么，可不填但建议写）。', '');
  L.push(`共 ${rows.length} 条。`, '', '---', '');
  for (const r of rows) {
    L.push(`## ${r.id} · ${r.task_type}`, '');
    L.push('**题目**', '', r.prompt.trim(), '');
    L.push('**A**', '', r.answer_a.trim(), '');
    L.push('**B**', '', r.answer_b.trim(), '');
    L.push('---', '');
  }
  return L.join('\n');
}

function csv(rows) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const head = 'id,choice,confidence,reason';
  const body = rows.map((r) => `${r.id},,,`).join('\n');
  return `${head}\n${body}\n`;
}

await runInTenant(async () => {
  const rows = await load();
  if (!rows.length) {
    console.log('没有待标注的 test 集样本（可能已全部标完，加 --all 看已标的）');
    return;
  }
  fs.mkdirSync(path.dirname(OUT_MD), { recursive: true });
  fs.writeFileSync(OUT_MD, md(rows), 'utf8');
  fs.writeFileSync(OUT_CSV, csv(rows), 'utf8');

  const byTask = {};
  for (const r of rows) byTask[r.task_type] = (byTask[r.task_type] || 0) + 1;
  console.log(`导出 ${rows.length} 条 → ${path.relative(ROOT, OUT_MD)} / .csv`);
  console.log('分题型：' + JSON.stringify(byTask));
  const bytes = fs.statSync(OUT_MD).size;
  console.log(`清单大小 ${(bytes / 1024).toFixed(1)} KB`);
});

await closePool();
