#!/usr/bin/env node
/**
 * EvalHub · 种子标注同步（data/annotations.json → PostgreSQL）
 *
 * 用途：
 *   1. 首次导入后校准 seed 行；
 *   2. 误删 / 误改后按冻结快照恢复；
 *   3. 换机器时快速重建 baseline（不需要重跑整个 migrate）。
 *
 * 幂等：以 (dataset, item_key, source='seed') 为单位「先删后插」，
 * 只动 seed，绝不碰 submitted（运行期真实标注）。
 *
 * 用法：
 *   DATABASE_URL=postgres://... node db/seeds-sync.mjs
 *   DATABASE_URL=... node db/seeds-sync.mjs --dry-run
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATASET_NAME = process.env.EVALHUB_DATASET || 'evalhub-core';
const DRY = process.argv.includes('--dry-run');

const seeds = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'annotations.json'), 'utf8'));
console.log(`读取种子标注 ${seeds.length} 条`);

if (DRY) {
  console.log('DRY RUN — 不连数据库');
  process.exit(0);
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL');
  process.exit(2);
}

const pg = await import('pg');
const client = new pg.default.Client({ connectionString: url });
await client.connect();

try {
  const { rows } = await client.query(
    `SELECT id, version FROM datasets WHERE name = $1 ORDER BY version DESC LIMIT 1`,
    [DATASET_NAME],
  );
  if (!rows.length) throw new Error(`找不到数据集 ${DATASET_NAME}`);
  const datasetId = rows[0].id;

  await client.query('BEGIN');
  let inserted = 0;
  for (const s of seeds) {
    const { rowCount } = await client.query(
      `DELETE FROM annotations
        WHERE dataset_id = $1 AND item_key = $2
          AND annotator_id IS NULL AND source = 'seed'`,
      [datasetId, s.id],
    );
    await client.query(
      `INSERT INTO annotations (dataset_id, item_key, annotator_id, choice, reason, confidence, source)
       VALUES ($1, $2, NULL, $3, $4, $5, 'seed')`,
      [datasetId, s.id, s.choice, s.reason ?? null, s.confidence ?? null],
    );
    inserted += 1;
    if (rowCount) console.log(`  覆盖已有 seed：${s.id}`);
  }

  const { rows: stat } = await client.query(
    `SELECT source, count(*)::int AS n FROM annotations WHERE dataset_id = $1 GROUP BY source ORDER BY source`,
    [datasetId],
  );

  await client.query('COMMIT');
  console.log(`同步完成：写入 ${inserted} 条 seed`);
  console.log('当前分布：' + stat.map((r) => `${r.source}=${r.n}`).join(' / '));
} catch (e) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('同步失败：', e.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
