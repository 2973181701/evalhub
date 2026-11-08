/**
 * EvalHub · 业务层（仓储无关）
 *
 * 本文件只做「业务计算 + 编排」，不碰文件系统、不碰数据库。
 * 数据读写全部交给 repo/ 下的实现（JSON 或 PostgreSQL），二者接口一致：
 *
 *   snapshot()        → { prompts, pairs, answers, seeds, submitted, byId }
 *   annotations()     → 合并后的标注列表（同 id 以运行期提交覆盖种子）
 *   saveAnnotation(r) → 持久化一条标注（异步）
 *
 * 之所以这样切：企业版要接 PostgreSQL / 多租户 / 审计，而「打分、判优、
 * 一致性、导出」这些规则必须继续只由 MoonBit 引擎单点定义，不能因为换存储而分叉。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { score, validateAnnotation, analyze, consistency, exportRlhf } from './engine.js';
import { createRepo, ROOT, DATA_DIR } from './repo/index.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export { ROOT, DATA_DIR };
export const BACKEND_DIR = HERE;

/** 启动时完成仓储选择（PG 模式会在此处连库并载入数据集快照） */
const repo = await createRepo();

/** 当前仓储形态，供 /api/health 自证「到底连的是文件还是数据库」 */
export function storageInfo() {
  return repo.describe();
}

/** 供上层（评测队列）拿到仓储实例，避免把数据集定位逻辑写两遍 */
export function repoRef() {
  return repo;
}

/** 同步读取数据集快照（进程内缓存，GET 接口无需 await） */
export function load() {
  return repo.snapshot();
}

/** 合并后的标注集：同 id 以「运行期最新提交」覆盖种子数据 */
export function annotations() {
  return repo.annotations();
}

/**
 * 提交一条标注：先过 MoonBit 标注引擎校验，不通过就拒收。
 * 校验是纯计算（同步），落库是异步，因此本函数返回 Promise。
 */
export async function submitAnnotation(payload) {
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
  await repo.saveAnnotation(record);
  return { accepted: true, check, record };
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
  const { prompts, pairs, answers, submitted } = load();
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
      submitted: submitted.length,
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
