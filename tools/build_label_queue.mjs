#!/usr/bin/env node
/**
 * EvalHub · 标注队列生成器（数据飞轮第 1 步）
 *
 * 背景：v1 的 20 组 A/B 全部是 (concise, verbose) 一种策略组合，
 * 人工标注分布 16:2:2。用它算出的 κ 既受同构偏差影响，也受极端类别不平衡影响。
 *
 * 本脚本从 data/prompts_extra.json 的 40 道题生成 120 组待标注 pair：
 *   - 8 种不同失败模式，其中 2 种是「真平手」，把平手类占比拉到约 25%
 *   - A/B 位置按 pair id 哈希随机化，设计意图随位置同步交换（消除位置偏差）
 *   - split 按题目 id 哈希切分，同题的所有变体必落在同一侧（防题目泄漏）
 *
 * ⚠️ expected_choice 只是**生成时的设计意图**，不是标签。
 *    金标准只能来自标注界面上真人点击产生的 label_annotations(label_source='human')。
 *    生成接口不会把 expected_choice 或 split 返回给标注界面。
 *
 * 用法：
 *   DATABASE_URL=... node tools/build_label_queue.mjs --dry-run
 *   DATABASE_URL=... node tools/build_label_queue.mjs --batch queue-v1
 *   DATABASE_URL=... node tools/build_label_queue.mjs --batch queue-v2 --per-prompt 4
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { query, withTransaction, closePool } from '../backend/db.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXTRA = path.join(ROOT, 'data', 'prompts_extra.json');

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');
const hnum = (s) => parseInt(sha(s).slice(0, 8), 16);

// ─────────────────────────── 答案构造算子（确定性，不编造事实） ───────────────────────────

/** 冗余文本只加"背景性废话"，不引入任何事实主张，避免把冗余答变成事实错答 */
const FILLER = '需要说明的是，不同资料的表述可能略有差异，建议结合具体上下文理解。'
  + '如果需要，我还可以进一步展开说明、补充背景、列举示例，或者用表格形式做对比，'
  + '也可以针对不同使用场景分别给出更详细的操作建议与注意事项。';

const concise = (t) => String(t.ref).trim();
const verbose = (t) => `${String(t.ref).trim()}。${FILLER}${FILLER}`;
const wrong = (t) => String(t.distractor).trim();
const offtopic = () => '这个问题涉及多个方面，建议查阅相关资料或官方文档。'
  + '不同场景下结论可能不同，需要结合具体情况综合判断，也可以咨询专业人士获取更准确的建议。';
const violation = (t) => `${String(t.ref).trim()}。${FILLER}${FILLER}${FILLER}${FILLER}`;
const hedging = (t) => `初步看，答案可能是「${t.distractor}」。不过重新审视一下，这个推断似乎有问题，`
  + `也许应该是「${t.ref}」。但再仔细想想，前面的假设未必成立，需要重新审视。`
  + '经过反复比较，两种说法好像都有道理，暂时无法给出确定结论，建议再次核对题目条件。';
const goodAlt = (t) => `简明地说：${String(t.ref).trim()}。`;
const badAlt = (t) => `一般认为是「${String(t.distractor).trim()}」。`;
const codeOnly = (t) => `def solve(x):\n    # ${String(t.ref).trim()}\n    return x`;
const codeExplained = (t) => `${codeOnly(t)}\n\n${'上面这段代码实现了题目要求的功能。'.repeat(8)}\n${FILLER}${FILLER}`;

// 每种策略：[/A 构造, /B 构造, 设计意图, 标签名]
const STRATEGIES = [
  { key: 'concise_vs_verbose', a: concise, b: verbose, want: 'A', sa: 'concise', sb: 'verbose' },
  { key: 'correct_vs_fact_error', a: concise, b: wrong, want: 'A', sa: 'correct', sb: 'fact_error' },
  { key: 'ontopic_vs_offtopic', a: concise, b: offtopic, want: 'A', sa: 'on_topic', sb: 'off_topic' },
  { key: 'compliant_vs_violation', a: concise, b: violation, want: 'A', sa: 'compliant', sb: 'constraint_violation' },
  { key: 'good_vs_good', a: concise, b: goodAlt, want: '平手', sa: 'correct_v1', sb: 'correct_v2' },
  { key: 'bad_vs_bad', a: wrong, b: badAlt, want: '平手', sa: 'wrong_v1', sb: 'wrong_v2' },
  { key: 'direct_vs_hedging', a: concise, b: hedging, want: 'A', sa: 'direct', sb: 'self_contradicting' },
  { key: 'code_only_vs_explained', a: codeOnly, b: codeExplained, want: 'A', sa: 'code_only', sb: 'code_with_explanation' },
];

/** 代码题优先用代码专属策略；其余题把第 8 种替换成另一种切题性对比，避免策略缺失 */
function strategiesFor(topic, i) {
  const picks = [i % 8, (i + 3) % 8, (i + 5) % 8];
  return picks.map((n) => {
    if (STRATEGIES[n].key === 'code_only_vs_explained' && topic.task_type !== '代码生成') {
      return STRATEGIES[2];
    }
    return STRATEGIES[n];
  });
}

function flipChoice(c) {
  return c === 'A' ? 'B' : c === 'B' ? 'A' : c;
}

// ─────────────────────────── 生成 ───────────────────────────

function buildPairs(topics, perPrompt, testSet) {
  const rows = [];
  topics.forEach((t, i) => {
    const picks = strategiesFor(t, i);
    for (let k = 0; k < perPrompt; k += 1) {
      const s = picks[k % picks.length];
      const id = `L${String(i + 1).padStart(2, '0')}${k + 1}`;
      let answerA = s.a(t);
      let answerB = s.b(t);
      let strategyA = s.sa;
      let strategyB = s.sb;
      let expected = s.want;

      // 位置随机化：按 pair id 哈希决定要不要交换，设计意图同步交换
      if (hnum(`flip:${id}`) % 2 === 0) {
        [answerA, answerB] = [answerB, answerA];
        [strategyA, strategyB] = [strategyB, strategyA];
        expected = flipChoice(expected);
      }

      // 同题同侧：split 只由题号决定，不由 pair id 决定。
      // 全量题目按哈希排序取前 30% 作为 test，比例可控且可复现。
      const split = testSet.has(t.id) ? 'test' : 'train';

      rows.push({
        id,
        source_prompt_id: t.id,
        task_type: t.task_type,
        prompt: t.prompt,
        reference: t.reference,
        answer_a: answerA,
        answer_b: answerB,
        strategy_a: strategyA,
        strategy_b: strategyB,
        expected_choice: expected,
        split,
        origin: 'generated',
      });
    }
  });
  return rows;
}

function contentHash(rows) {
  const normalized = rows
    .map((r) => [r.id, r.prompt, r.answer_a, r.answer_b, r.expected_choice, r.split].join('\u0000'))
    .sort()
    .join('\u0001');
  return sha(normalized);
}

function stats(rows) {
  const count = (fn) => {
    const d = {};
    for (const r of rows) d[fn(r)] = (d[fn(r)] ?? 0) + 1;
    return d;
  };
  const testTopics = new Set(rows.filter((r) => r.split === 'test').map((r) => r.source_prompt_id));
  const trainTopics = new Set(rows.filter((r) => r.split === 'train').map((r) => r.source_prompt_id));
  return {
    total: rows.length,
    by_strategy: count((r) => `${r.strategy_a}|${r.strategy_b}`),
    by_expected: count((r) => r.expected_choice),
    by_task_type: count((r) => r.task_type),
    by_split: count((r) => r.split),
    topics: { total: trainTopics.size + testTopics.size, test: testTopics.size, train: trainTopics.size },
    // 同题泄漏检查：任何题同时出现在两侧即为错误
    leakage: [...testTopics].filter((x) => trainTopics.has(x)),
    avg_len_a: Math.round(rows.reduce((s, r) => s + r.answer_a.length, 0) / rows.length),
    avg_len_b: Math.round(rows.reduce((s, r) => s + r.answer_b.length, 0) / rows.length),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const arg = (k, d) => {
    const i = args.indexOf(k);
    return i >= 0 && args[i + 1] ? args[i + 1] : d;
  };
  const dryRun = args.includes('--dry-run');
  const batch = arg('--batch', 'queue-v1');
  const perPrompt = Math.max(1, Math.min(4, Number(arg('--per-prompt', 3))));

  if (!process.env.DATABASE_URL) {
    console.error('标注队列需要 PostgreSQL：请设置 DATABASE_URL');
    process.exit(1);
  }

  const topics = JSON.parse(fs.readFileSync(EXTRA, 'utf8'));
  for (const t of topics) {
    if (!t.reference || !t.distractor || !t.task_type) {
      throw new Error(`题目 ${t.id} 缺少 reference / distractor / task_type`);
    }
  }

  // 留出集：题目按哈希排序，取前 30% —— 按题目切分而非按 pair 切分
  const ranked = [...topics].sort((x, y) => sha(`split:${x.id}`).localeCompare(sha(`split:${y.id}`)));
  const testSet = new Set(ranked.slice(0, Math.round(topics.length * 0.3)).map((t) => t.id));

  const rows = buildPairs(topics, perPrompt, testSet);
  const st = stats(rows);
  const hash = contentHash(rows);

  console.log(`批次 ${batch} · 题目 ${st.topics.total} 道 · 生成 ${st.total} 组 A/B`);
  console.log('设计意图分布（仅后台，不参与标注）：', st.by_expected);
  console.log('split 分布：', st.by_split, '| 题目 train/test =', st.topics.train, '/', st.topics.test);
  console.log('题型分布：', st.by_task_type);
  console.log('平均长度 A/B：', st.avg_len_a, '/', st.avg_len_b);
  console.log('同题跨侧泄漏：', st.leakage.length ? st.leakage.join(',') : '无 ✓');
  console.log('策略种类：', Object.keys(st.by_strategy).length);
  console.log('内容哈希：', hash.slice(0, 16));
  if (st.leakage.length) throw new Error('存在题目泄漏，拒绝写入');

  if (dryRun) {
    console.log('\n--dry-run：以上为统计，未写库。样例：');
    for (const r of rows.slice(0, 2)) {
      console.log(`  ${r.id} [${r.task_type}] 意图=${r.expected_choice} split=${r.split} A(${r.answer_a.length}字) B(${r.answer_b.length}字)`);
    }
    await closePool();
    return;
  }

  const written = await withTransaction(async (client) => {
    const exist = await client.query('SELECT content_hash, pair_count FROM label_batches WHERE name=$1', [batch]);
    if (exist.rows.length) {
      if (exist.rows[0].content_hash === hash) {
        return { skipped: true, count: Number(exist.rows[0].pair_count) };
      }
      throw new Error(`批次 ${batch} 已存在且内容不同。数据集不可变，请换一个 --batch 名称。`);
    }

    await client.query(
      `INSERT INTO label_batches (name, generator, config, content_hash, pair_count, note)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6)`,
      [
        batch,
        'build_label_queue.mjs@v1',
        JSON.stringify({ per_prompt: perPrompt, topics: topics.length, strategies: STRATEGIES.length }),
        hash,
        rows.length,
        '8 种失败模式；位置随机化；按题目哈希切分留出集；expected_choice 为设计意图而非标签',
      ],
    );
    const { rows: b } = await client.query('SELECT id FROM label_batches WHERE name=$1', [batch]);
    const batchId = b[0].id;

    for (const r of rows) {
      await client.query(
        `INSERT INTO label_pairs
           (id, batch_id, source_prompt_id, task_type, prompt, reference,
            answer_a, answer_b, strategy_a, strategy_b, expected_choice, split, origin)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (id) DO NOTHING`,
        [r.id, batchId, r.source_prompt_id, r.task_type, r.prompt, r.reference,
          r.answer_a, r.answer_b, r.strategy_a, r.strategy_b, r.expected_choice, r.split, r.origin],
      );
    }
    return { skipped: false, count: rows.length, batch_id: batchId };
  });

  if (written.skipped) {
    console.log(`\n内容未变化，跳过写入（已有 ${written.count} 组）`);
  } else {
    console.log(`\n已写入批次 ${batch}：${written.count} 组 A/B，等待人工标注`);
  }

  const q = await query('SELECT count(*) AS n, count(*) FILTER (WHERE NOT labeled) AS pending FROM v_label_queue');
  console.log('队列状态：', q.rows[0]);
  await closePool();
}

main().catch(async (e) => {
  console.error('生成失败：', e.message);
  await closePool().catch(() => {});
  process.exit(1);
});
