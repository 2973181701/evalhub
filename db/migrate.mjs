#!/usr/bin/env node
/**
 * EvalHub · JSON → PostgreSQL 迁移脚本
 *
 * 用法：
 *   node db/migrate.mjs --dry-run          # 只算哈希、打印将写入的行数，不连数据库
 *   DATABASE_URL=postgres://... node db/migrate.mjs
 *   DATABASE_URL=... node db/migrate.mjs --name evalhub-core   # 指定数据集名（默认 evalhub-core）
 *
 * 设计要点：
 *   - 幂等：同一 name + content_hash 已存在则直接跳过，不产生新版本。
 *   - 不可变：内容变了就新增 version，绝不 UPDATE 旧版本。
 *   - 种子标注 source='seed'，annotator_id 为 NULL（历史快照，无归属人）。
 *   - 全部在一个事务内完成，失败整体回滚。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA_DIR = path.join(ROOT, 'data');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NAME = (() => {
  const i = args.indexOf('--name');
  return i >= 0 && args[i + 1] ? args[i + 1] : 'evalhub-core';
})();

function readJson(file) {
  const p = path.join(DATA_DIR, file);
  if (!fs.existsSync(p)) throw new Error(`缺少数据文件：${p}`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** 规范化序列化：对象键排序，保证同一内容恒得同一哈希 */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// ---------- 1. 读取与规范化 ----------

const prompts = readJson('prompts.json');
const pairs = readJson('pairs.json');
const answers = readJson('answers.json');
const seeds = readJson('annotations.json');

const items = prompts.map((p) => ({
  item_key: p.id,
  task_type: p.task_type,
  prompt: p.prompt,
  reference: p.reference ?? null,
}));

const pairRows = pairs.map((p) => ({
  item_key: p.id,
  task_type: p.task_type,
  prompt: p.prompt,
  reference: p.reference ?? null,
  answer_a: p.answer_A,
  answer_b: p.answer_B,
  strategy_a: p.strategy_A ?? null,
  strategy_b: p.strategy_B ?? null,
  strategy_a_label: p.strategy_A_label ?? null,
  strategy_b_label: p.strategy_B_label ?? null,
}));

const answerRows = answers.map((a) => ({
  item_key: a.id,
  task_type: a.task_type,
  prompt: a.prompt,
  answer: a.answer,
  model: 'glm-4-flash',
}));

const annotationRows = seeds.map((a) => ({
  item_key: a.id,
  choice: a.choice,
  reason: a.reason ?? null,
  confidence: a.confidence ?? null,
}));

const taskTypes = [...new Set(items.map((i) => i.task_type))].sort();

const contentHash = sha256(
  canonical({ items, pairs: pairRows, answers: answerRows }),
);

// ---------- 2. 一致性自检（迁移前先证明数据本身没坏） ----------

const problems = [];

const itemKeys = new Set(items.map((i) => i.item_key));
if (itemKeys.size !== items.length) problems.push('prompts.json 存在重复 id');

for (const p of pairRows) {
  if (!itemKeys.has(p.item_key)) problems.push(`pairs.json 的 ${p.item_key} 在 prompts.json 中不存在`);
}
for (const a of answerRows) {
  if (!itemKeys.has(a.item_key)) problems.push(`answers.json 的 ${a.item_key} 在 prompts.json 中不存在`);
}
for (const a of annotationRows) {
  if (!itemKeys.has(a.item_key)) problems.push(`annotations.json 的 ${a.item_key} 在 prompts.json 中不存在`);
  if (!['A', 'B', '平手'].includes(a.choice)) problems.push(`标注 ${a.item_key} 的 choice 非法：${a.choice}`);
  if (a.confidence != null && (a.confidence < 1 || a.confidence > 5)) {
    problems.push(`标注 ${a.item_key} 的 confidence 越界：${a.confidence}`);
  }
}

if (pairRows.length !== items.length) {
  problems.push(`pairs 数(${pairRows.length}) 与 items 数(${items.length}) 不一致`);
}
if (answerRows.length !== items.length) {
  problems.push(`answers 数(${answerRows.length}) 与 items 数(${items.length}) 不一致`);
}

if (problems.length) {
  console.error('迁移前自检失败，已中止：');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const summary = {
  dataset: NAME,
  content_hash: contentHash.slice(0, 16) + '…',
  task_types: taskTypes,
  items: items.length,
  pairs: pairRows.length,
  answers: answerRows.length,
  seed_annotations: annotationRows.length,
};

if (DRY_RUN) {
  console.log('DRY RUN — 不连数据库');
  console.log(JSON.stringify(summary, null, 2));
  console.log('\n自检通过：id 无重复、引用全部可解析、choice/confidence 取值合法。');
  process.exit(0);
}

// ---------- 3. 写入 PostgreSQL ----------

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('缺少 DATABASE_URL。示例：');
  console.error('  DATABASE_URL=postgres://evalhub:evalhub@localhost:5432/evalhub node db/migrate.mjs');
  process.exit(2);
}

let pg;
try {
  pg = await import('pg');
} catch {
  console.error('缺少依赖 pg。请先执行： npm install pg');
  process.exit(2);
}

const client = new pg.default.Client({ connectionString: url });
await client.connect();

try {
  await client.query('BEGIN');

  // 表必须已存在；schema.sql 由使用者显式执行，避免脚本静默改结构
  const { rows: tbl } = await client.query(
    `SELECT to_regclass('public.datasets') AS t`,
  );
  if (!tbl[0].t) {
    throw new Error('未找到 datasets 表，请先执行： psql "$DATABASE_URL" -f db/schema.sql');
  }

  const { rows: existing } = await client.query(
    `SELECT id, version FROM datasets WHERE name = $1 AND content_hash = $2`,
    [NAME, contentHash],
  );

  if (existing.length) {
    console.log(
      `内容未变化，跳过导入：${NAME} v${existing[0].version}（hash ${contentHash.slice(0, 16)}…）`,
    );
    await client.query('COMMIT');
    process.exit(0);
  }

  const { rows: next } = await client.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS v FROM datasets WHERE name = $1`,
    [NAME],
  );
  const version = next[0].v;

  const { rows: ds } = await client.query(
    `INSERT INTO datasets (name, version, content_hash, task_types, item_count, note)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [NAME, version, contentHash, taskTypes, items.length, 'migrated from data/*.json'],
  );
  const datasetId = ds[0].id;

  for (const it of items) {
    await client.query(
      `INSERT INTO dataset_items (dataset_id, item_key, task_type, prompt, reference)
       VALUES ($1, $2, $3, $4, $5)`,
      [datasetId, it.item_key, it.task_type, it.prompt, it.reference],
    );
  }
  for (const p of pairRows) {
    await client.query(
      `INSERT INTO dataset_pairs
         (dataset_id, item_key, task_type, prompt, reference, answer_a, answer_b,
          strategy_a, strategy_b, strategy_a_label, strategy_b_label)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        datasetId, p.item_key, p.task_type, p.prompt, p.reference, p.answer_a, p.answer_b,
        p.strategy_a, p.strategy_b, p.strategy_a_label, p.strategy_b_label,
      ],
    );
  }
  for (const a of answerRows) {
    await client.query(
      `INSERT INTO dataset_answers (dataset_id, item_key, task_type, prompt, answer, model)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [datasetId, a.item_key, a.task_type, a.prompt, a.answer, a.model],
    );
  }
  for (const a of annotationRows) {
    await client.query(
      `INSERT INTO annotations (dataset_id, item_key, annotator_id, choice, reason, confidence, source)
       VALUES ($1,$2,NULL,$3,$4,$5,'seed')
       ON CONFLICT (dataset_id, item_key, annotator_id) DO NOTHING`,
      [datasetId, a.item_key, a.choice, a.reason, a.confidence],
    );
  }

  await client.query(
    `INSERT INTO audit_logs (actor_id, action, target, detail)
     VALUES (NULL, 'dataset.import', $1, $2)`,
    [`${NAME}@v${version}`, JSON.stringify({ ...summary, version })],
  );

  await client.query('COMMIT');
  console.log(`导入完成：${NAME} v${version}（dataset_id=${datasetId}）`);
  console.log(JSON.stringify(summary, null, 2));
} catch (err) {
  await client.query('ROLLBACK').catch(() => {});
  console.error('导入失败，已回滚：', err.message);
  process.exitCode = 1;
} finally {
  await client.end();
}
