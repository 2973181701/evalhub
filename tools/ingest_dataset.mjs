#!/usr/bin/env node
/**
 * 评测集接入 CLI
 *
 * 用法：
 *   DATABASE_URL=... node tools/ingest_dataset.mjs --file data/inbox/sample_prompts.json --dry-run
 *   DATABASE_URL=... node tools/ingest_dataset.mjs --file data/inbox/sample_prompts.json --name ingest-demo-01
 *   DATABASE_URL=... node tools/ingest_dataset.mjs --list
 *   DATABASE_URL=... node tools/ingest_dataset.mjs --rejects ingest-demo-01
 *
 * 注意：样例数据是 synthetic，不是真实业务数据；报告里会写明来源。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ingest, listBatches, listRejects, IngestError } from '../backend/governance/ingest.js';
import { closePool } from '../backend/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};

async function main() {
  if (argv.includes('--list')) {
    const rows = await listBatches(Number(arg('--limit', 20)));
    for (const r of rows) {
      console.log(`${r.name.padEnd(22)} ${r.status.padEnd(10)} ${r.accepted_count}/${r.row_count} 条 → ${r.target_dataset ?? '-'}@v${r.target_version ?? '-'}`);
    }
    await closePool();
    return;
  }
  if (argv.includes('--rejects')) {
    const name = arg('--rejects', null);
    if (!name) throw new IngestError('--rejects 需要批次名');
    const rows = await listRejects(name);
    for (const r of rows) console.log(`  行 ${r.row_index}: ${r.reason}`);
    console.log(`共 ${rows.length} 条拒绝`);
    await closePool();
    return;
  }

  const file = arg('--file', null);
  if (!file) throw new IngestError('需要 --file 指定 JSON/CSV 文件');
  const full = path.isAbsolute(file) ? file : path.join(ROOT, file);
  if (!fs.existsSync(full)) throw new IngestError(`文件不存在：${full}`);

  const sourceType = arg('--type', full.toLowerCase().endsWith('.csv') ? 'csv' : 'json');
  const name = arg('--name', `ingest-${Date.now().toString(36)}`);
  const datasetName = arg('--dataset', 'ingested');
  const dryRun = argv.includes('--dry-run');

  const result = await ingest({
    name,
    sourceType,
    sourceUri: path.relative(ROOT, full).replace(/\\/g, '/'),
    text: fs.readFileSync(full, 'utf8'),
    datasetName,
    dryRun,
  });

  console.log(`批次 ${result.batch} | 来源 ${result.source_uri} | ${result.source_type} | hash ${result.content_hash}`);
  console.log(`行数 ${result.row_count} / 接受 ${result.accepted_count} / 拒绝 ${result.rejected_count} | 状态 ${result.status}`);
  if (result.dataset) {
    console.log(`目标数据集 ${result.dataset}${result.reused_existing_dataset ? '（复用已有版本）' : '（新建版本）'}`);
  }
  if (result.reason) console.log(`说明：${result.reason}`);
  for (const r of result.rejects) console.log(`  拒绝 行 ${r.row_index}: ${r.reason}`);
  await closePool();
}

main().catch(async (e) => {
  console.error('接入失败：', e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
