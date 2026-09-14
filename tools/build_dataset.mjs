#!/usr/bin/env node
/**
 * EvalHub · 真实数据管道（阶段 2 验收）
 *
 * 作用：把用户已有的真实数据接进 MoonBit 引擎，跑出一条完整的真实产物链。
 *
 *   输入（只读，绝不修改原文件）
 *     ../llm-eval-project/prompts.json                                20 条评测题（含参考答案）
 *     ../llm-eval-project/outputs/answers.json                        GLM 的真实回答
 *     ../data-annotation-project/data/pairs.json                      20 组 A/B 偏好对
 *     ../data-annotation-project/annotations/annotations_summary.csv   人工标注结果
 *
 *   产出（写入 evalhub/data/）
 *     data/prompts.json / answers.json / pairs.json    原样快照（让仓库自包含、可复现）
 *     data/annotations.json                            CSV → JSON 的规范标注集
 *     data/out/scores.json                             评测引擎：20 条五维打分
 *     data/out/report.json                             分析引擎：均分 / 雷达图 / 需复核样本
 *     data/out/annotation_check.json                   标注引擎：20 条校验与质检标记
 *     data/out/rlhf_dpo.json / rlhf_openai.json        数据引擎：RLHF 偏好训练集
 *     data/out/consistency.json                        一致性引擎：人工 vs 规则判优 的一致率与 κ
 *
 * 运行：node tools/build_dataset.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  version,
  eval_engine,
  annotate_engine,
  analyze_engine,
  consistency_engine,
  export_rlhf,
} from '../core/_build/js/debug/build/src/src.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SRC = path.resolve(ROOT, '..'); // 简历生成/
const DATA = path.join(ROOT, 'data');
const OUT = path.join(DATA, 'out');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const writeJson = (p, obj) => fs.writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8');
const line = (t) => console.log('\n' + '─'.repeat(66) + '\n' + t + '\n' + '─'.repeat(66));

/** 最小 CSV 解析：支持 BOM、双引号包裹、字段内逗号 */
function parseCsv(text) {
  const s = text.replace(/^\uFEFF/, '');
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  const header = rows.shift();
  return rows
    .filter((r) => r.some((v) => v.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h.trim(), (r[i] ?? '').trim()])));
}

const scoreOf = (prompt, answer, reference, task_type) =>
  JSON.parse(eval_engine(JSON.stringify({ prompt, answer, reference, task_type })));

function main() {
  fs.mkdirSync(DATA, { recursive: true });
  fs.mkdirSync(OUT, { recursive: true });

  console.log(`EvalHub 引擎版本：${version()}`);

  // ---------- 1. 数据快照 ----------
  const prompts = readJson(path.join(SRC, 'llm-eval-project/prompts.json'));
  const answers = readJson(path.join(SRC, 'llm-eval-project/outputs/answers.json'));
  const pairs = readJson(path.join(SRC, 'data-annotation-project/data/pairs.json'));
  const csv = parseCsv(
    fs.readFileSync(path.join(SRC, 'data-annotation-project/annotations/annotations_summary.csv'), 'utf8'),
  );

  writeJson(path.join(DATA, 'prompts.json'), prompts);
  writeJson(path.join(DATA, 'answers.json'), answers);
  writeJson(path.join(DATA, 'pairs.json'), pairs);

  const annotations = csv.map((r) => ({
    id: r.id,
    task_type: r.task_type,
    choice: r.choice,
    reason: r.reason,
    confidence: Number(r.confidence),
  }));
  writeJson(path.join(DATA, 'annotations.json'), annotations);

  line('1. 数据快照（原文件只读，未修改）');
  console.log(
    `评测题 ${prompts.length} 条 / 真实回答 ${answers.length} 条 / A-B 偏好对 ${pairs.length} 组 / 人工标注 ${annotations.length} 条`,
  );

  // ---------- 2. 评测引擎 ----------
  const answerById = new Map(answers.map((a) => [a.id, a.answer]));
  const scores = [];
  for (const p of prompts) {
    const s = scoreOf(p.prompt, answerById.get(p.id) ?? '', p.reference ?? '', p.task_type);
    if (!s.error) scores.push({ id: p.id, task_type: p.task_type, ...s });
  }
  writeJson(path.join(OUT, 'scores.json'), scores);

  line('2. 评测引擎 · 20 条真实回答五维打分');
  const mean = (k) => scores.reduce((s, x) => s + x[k], 0) / scores.length;
  console.log(`样本数：${scores.length}`);
  for (const d of ['accuracy', 'completeness', 'logic', 'safety', 'expression', 'total']) {
    console.log(`  ${d.padEnd(13)} 均分 ${mean(d).toFixed(2)}`);
  }
  console.log(
    '  最低分样本：' +
      scores
        .slice()
        .sort((a, b) => a.total - b.total)
        .slice(0, 3)
        .map((s) => `${s.id}=${s.total}`)
        .join('  '),
  );

  // ---------- 3. 分析引擎 ----------
  const report = JSON.parse(analyze_engine(JSON.stringify({ scores })));
  writeJson(path.join(OUT, 'report.json'), report);

  line('3. 分析引擎 · 统计报告');
  console.log(
    `五维均分：${Object.entries(report.dimensions)
      .map(([k, v]) => `${k} ${v}`)
      .join(' / ')}`,
  );
  console.log(`总分均分：${report.total}`);
  for (const t of report.by_task_type) console.log(`  ${t.task_type.padEnd(6)} n=${t.count} 均分 ${t.total}`);
  console.log('最需人工复核（总分最低）：' + report.lowest_total.map((s) => `${s.id}(${s.total})`).join(' '));
  console.log('引擎最拿不准（五维极差最大）：' + report.max_spread.map((s) => `${s.id}(${s.spread})`).join(' '));

  // ---------- 4. 标注引擎 ----------
  const pairById = new Map(pairs.map((p) => [p.id, p]));
  const checks = annotations.map((a) => {
    const pair = pairById.get(a.id) ?? {};
    const raw = JSON.parse(
      annotate_engine(
        JSON.stringify({
          id: a.id,
          answer_A: pair.answer_A ?? '',
          answer_B: pair.answer_B ?? '',
          choice: a.choice,
          reason: a.reason,
          confidence: a.confidence,
        }),
      ),
    );
    return { ...raw, task_type: a.task_type };
  });
  writeJson(path.join(OUT, 'annotation_check.json'), checks);

  line('4. 标注引擎 · 20 条真实人工标注校验');
  const validCount = checks.filter((c) => c.valid).length;
  const flagCount = {};
  for (const c of checks) for (const f of c.flags) flagCount[f] = (flagCount[f] ?? 0) + 1;
  const tieCount = annotations.filter((a) => a.choice === '平手').length;
  console.log(`校验通过：${validCount}/${checks.length}`);
  console.log(
    `平手数：${tieCount}（平手率 ${((tieCount / annotations.length) * 100).toFixed(1)}%，标注规范要求 ≤30%）`,
  );
  console.log('质检标记分布：' + (Object.keys(flagCount).length ? JSON.stringify(flagCount) : '（无）'));
  console.log(
    '置信度分布：' + [1, 2, 3, 4, 5].map((n) => `${n}分×${annotations.filter((a) => a.confidence === n).length}`).join('  '),
  );

  // ---------- 5. 数据引擎 ----------
  const merged = annotations.map((a) => {
    const pair = pairById.get(a.id) ?? {};
    return {
      id: a.id,
      task_type: a.task_type,
      prompt: pair.prompt ?? '',
      answer_A: pair.answer_A ?? '',
      answer_B: pair.answer_B ?? '',
      choice: a.choice,
    };
  });
  const dpo = JSON.parse(export_rlhf(JSON.stringify({ format: 'dpo', annotations: merged })));
  const openai = JSON.parse(export_rlhf(JSON.stringify({ format: 'openai', annotations: merged })));
  writeJson(path.join(OUT, 'rlhf_dpo.json'), dpo);
  writeJson(path.join(OUT, 'rlhf_openai.json'), openai);

  line('5. 数据引擎 · RLHF 偏好训练集导出');
  console.log(`输入标注 ${dpo.total} 条 → 导出 ${dpo.exported} 条，丢弃 ${dpo.dropped} 条`);
  console.log('丢弃明细：' + JSON.stringify(dpo.dropped_detail));
  const chosenA = dpo.data.filter((d) => d.chosen === pairById.get(d.id).answer_A).length;
  console.log(`chosen 来自「简洁约束版」A：${chosenA} 条 / 来自「详尽展开版」B：${dpo.exported - chosenA} 条`);

  // ---------- 6. 一致性引擎 ----------
  // 诚实前提：当前只有 1 位人工标注者，无法计算「人工之间」的 κ。
  // 这里用「人工标注」与「规则引擎判优」构成两位标注者，算的是真实可算的一致率与 κ。
  const engineChoices = pairs.map((p) => {
    const a = scoreOf(p.prompt, p.answer_A, p.reference ?? '', p.task_type);
    const b = scoreOf(p.prompt, p.answer_B, p.reference ?? '', p.task_type);
    const choice = a.total > b.total ? 'A' : a.total < b.total ? 'B' : '平手';
    return { id: p.id, annotator: 'rule_judge', choice, total_A: a.total, total_B: b.total };
  });
  const records = [
    ...annotations.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
    ...engineChoices.map((e) => ({ id: e.id, annotator: 'rule_judge', choice: e.choice })),
  ];
  const consistency = JSON.parse(consistency_engine(JSON.stringify({ records })));
  writeJson(path.join(OUT, 'consistency.json'), consistency);
  writeJson(path.join(OUT, 'rule_judge.json'), engineChoices);

  line('6. 一致性引擎 · 人工标注 vs 规则引擎判优');
  console.log(`标注者：${consistency.annotators.join(' / ')}`);
  console.log(`样本：${consistency.items_rated} 条（完整标注 ${consistency.items_complete} 条）`);
  console.log(`成对一致率：${(consistency.pairwise_agreement * 100).toFixed(1)}%`);
  console.log(`全票一致率：${(consistency.unanimous_rate * 100).toFixed(1)}%`);
  console.log(`Fleiss' κ ：${consistency.fleiss_kappa === null ? 'null —— ' + consistency.kappa_note : consistency.fleiss_kappa}`);
  console.log(`存在分歧的样本（${consistency.disputed_items.length} 条）：${consistency.disputed_items.join(' ')}`);

  // ---------- 7. 单人标注的诚实结论 ----------
  const soloConsistency = JSON.parse(
    consistency_engine(
      JSON.stringify({ records: annotations.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })) }),
    ),
  );
  writeJson(path.join(OUT, 'consistency_single_annotator.json'), soloConsistency);

  line('7. 诚实声明 · 单人标注');
  console.log(`标注者数量：${soloConsistency.annotators.length}`);
  console.log(`Fleiss' κ ：${soloConsistency.fleiss_kappa === null ? 'null' : soloConsistency.fleiss_kappa}`);
  console.log(`原因：${soloConsistency.kappa_note}`);
  console.log('说明：当前 20 条标注由 1 人完成，人工间一致性无法计算；');
  console.log('      上表的「人工 vs 规则引擎」一致率是两个真实评分者的真实结果，可直接写入报告。');

  line('完成');
  console.log('产物目录：' + path.relative(ROOT, OUT));
  for (const f of fs.readdirSync(OUT)) {
    console.log(`  ${f.padEnd(34)} ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(1)} KB`);
  }
}

main();
