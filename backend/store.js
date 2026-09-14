/**
 * EvalHub · 数据仓库层
 *
 * 数据来源全部是用户已有的真实产物（只读快照，见 tools/build_dataset.mjs）：
 *   data/prompts.json     20 条评测题（含参考答案）
 *   data/answers.json     GLM 的真实回答
 *   data/pairs.json       20 组 A/B 偏好对
 *   data/annotations.json 20 条真实人工标注
 *
 * 本层额外维护「运行期新提交的标注」，落盘到 data/out/annotations_submitted.json，
 * 重启后不丢；与种子标注合并时，同一 id 以最新提交为准。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, validateAnnotation, analyze, consistency, exportRlhf } from './engine.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(HERE, '..');
export const DATA_DIR = path.join(ROOT, 'data');
const OUT_DIR = path.join(DATA_DIR, 'out');
const SUBMITTED_FILE = path.join(OUT_DIR, 'annotations_submitted.json');

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureData() {
  const missing = ['prompts.json', 'pairs.json', 'annotations.json'].filter(
    (f) => !fs.existsSync(path.join(DATA_DIR, f)),
  );
  if (missing.length) {
    throw new Error(
      `缺少数据文件：${missing.join(', ')}。请先在 evalhub 根目录执行： node tools/build_dataset.mjs`,
    );
  }
}

let cache = null;

/** 懒加载 + 缓存（数据文件不大，进程内只读一次） */
export function load() {
  if (cache) return cache;
  ensureData();
  const prompts = readJson(path.join(DATA_DIR, 'prompts.json'), []);
  const pairs = readJson(path.join(DATA_DIR, 'pairs.json'), []);
  const answers = readJson(path.join(DATA_DIR, 'answers.json'), []);
  const seeds = readJson(path.join(DATA_DIR, 'annotations.json'), []);
  const submitted = readJson(SUBMITTED_FILE, []);
  cache = {
    prompts,
    pairs,
    answers,
    seeds,
    submitted,
    byId: {
      prompt: new Map(prompts.map((p) => [p.id, p])),
      pair: new Map(pairs.map((p) => [p.id, p])),
      answer: new Map(answers.map((a) => [a.id, a])),
    },
  };
  return cache;
}

/** 合并后的标注集：同 id 以「运行期最新提交」覆盖种子数据 */
export function annotations() {
  const { seeds, submitted } = load();
  const map = new Map(seeds.map((a) => [a.id, { ...a, source: 'seed' }]));
  for (const a of submitted) map.set(a.id, { ...a, source: 'submitted' });
  return [...map.values()];
}

/** 提交一条标注：先过 MoonBit 标注引擎校验，不通过就拒收 */
export function submitAnnotation(payload) {
  const pair = load().byId.pair.get(payload.id) ?? {};
  const check = validateAnnotation({
    id: payload.id,
    answer_A: payload.answer_A ?? pair.answer_A ?? '',
    answer_B: payload.answer_B ?? pair.answer_B ?? '',
    choice: payload.choice,
    reason: payload.reason,
    confidence: payload.confidence,
  });
  if (!check.valid) {
    return { accepted: false, check };
  }
  const record = {
    id: payload.id,
    task_type: payload.task_type ?? pair.task_type ?? '',
    choice: check.choice,
    reason: payload.reason,
    confidence: check.confidence,
    annotated_at: new Date().toISOString(),
  };
  const { submitted } = load();
  const idx = submitted.findIndex((x) => x.id === record.id);
  if (idx >= 0) submitted[idx] = record;
  else submitted.push(record);
  persistSubmitted(submitted);
  return { accepted: true, check, record };
}

function persistSubmitted(list) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(SUBMITTED_FILE, JSON.stringify(list, null, 2), 'utf8');
}

/** 用评测引擎给 20 条真实回答打分（确定性，可随时重算） */
export function scoresOfRealAnswers() {
  const { prompts, byId } = load();
  const out = [];
  for (const p of prompts) {
    const s = score({
      prompt: p.prompt,
      answer: byId.answer.get(p.id)?.answer ?? '',
      reference: p.reference ?? '',
      task_type: p.task_type,
    });
    if (!s.error) out.push({ id: p.id, task_type: p.task_type, ...s });
  }
  return out;
}

/**
 * 规则判优（第二个「标注者」）：
 * 用评测引擎分别给 A / B 打分，总分高者胜。用于计算「人工 vs 规则」一致率。
 * 注意：规则判优不理解「格式约束优先」的标注规范，一致率天然偏低——
 * 这恰好是「为什么需要人工标注 / LLM-as-Judge」的最好论据。
 */
export function ruleJudge() {
  const { pairs } = load();
  return pairs.map((p) => {
    const a = score({ prompt: p.prompt, answer: p.answer_A, reference: p.reference ?? '', task_type: p.task_type });
    const b = score({ prompt: p.prompt, answer: p.answer_B, reference: p.reference ?? '', task_type: p.task_type });
    const ta = a.total ?? 0;
    const tb = b.total ?? 0;
    return {
      id: p.id,
      task_type: p.task_type,
      choice: ta > tb ? 'A' : ta < tb ? 'B' : '平手',
      total_A: ta,
      total_B: tb,
    };
  });
}

/** 一致性：人工标注 vs 规则判优 */
export function consistencyReport() {
  const ann = annotations();
  const records = [
    ...ann.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
    ...ruleJudge().map((r) => ({ id: r.id, annotator: 'rule_judge', choice: r.choice })),
  ];
  return consistency({ records });
}

/** 仅人工标注者时的一致性（诚实暴露「单人无法算 κ」） */
export function soloConsistency() {
  return consistency({
    records: annotations().map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
  });
}

/** 汇总报告：数据集规模 + 五维统计 + 一致性 + 平手率 */
export function fullReport() {
  const { prompts, pairs, answers } = load();
  const scores = scoresOfRealAnswers();
  const stats = analyze({ scores });
  const ann = annotations();
  const tie = ann.filter((a) => a.choice === '平手').length;
  return {
    dataset: {
      prompts: prompts.length,
      pairs: pairs.length,
      answers: answers.length,
      annotations: ann.length,
      submitted: load().submitted.length,
    },
    scores: stats,
    score_rows: scores,
    consistency: consistencyReport(),
    solo_consistency: soloConsistency(),
    annotation_quality: {
      tie_count: tie,
      tie_rate: ann.length ? Number(((tie / ann.length) * 100).toFixed(1)) : 0,
      mean_confidence: ann.length
        ? Number((ann.reduce((s, a) => s + (a.confidence || 0), 0) / ann.length).toFixed(2))
        : 0,
    },
  };
}

/**
 * 导出 RLHF 训练集。
 * 注意：这里不做任何筛选，把全部标注原样交给 MoonBit 数据引擎——
 * 「平手丢弃 / 非法 choice 丢弃 / 零信息样本丢弃」的规则只由引擎一处定义，
 * 避免同一套业务规则在 JS 和 MoonBit 里各写一遍、日后走偏。
 */
export function rlhfExport(format = 'dpo') {
  const { byId } = load();
  const items = annotations().map((a) => {
    const pair = byId.pair.get(a.id) ?? {};
    return {
      id: a.id,
      task_type: a.task_type,
      prompt: pair.prompt ?? '',
      answer_A: pair.answer_A ?? '',
      answer_B: pair.answer_B ?? '',
      choice: a.choice,
    };
  });
  return exportRlhf({ format, annotations: items });
}
