#!/usr/bin/env node
/**
 * 构造 SFT 训练集（约束遵循）
 *
 * 任务定义：让 1.7B 的小模型学会「按题目要求作答」——
 *   - 问事实就只给事实，不要展开成小作文
 *   - 要标签就只给标签
 *   - 有字数限制就守住字数
 * 这是基线评测暴露出来的真实短板（glm-4-flash 在摘要/推理题上准确性只有 0.67/1.88，
 * 而且答案普遍比题目要求长一个数量级）。
 *
 * 数据来源与红线：
 *   - 题面来自 data/prompts_extra.json（40 题），与评测集 20 题**无 ID、无题干重叠**，
 *     因此训练集与评测集不存在泄漏。
 *   - 答案由 GLM 按「必须包含参考要点 + 必须守约束」生成，属于**蒸馏**，
 *     不是人工标注。名单里逐条记录 source=distilled:glm-4-flash，报告里也必须这么写。
 *   - 每条答案都要过机器校验（长度约束、要点覆盖），不过就丢，不凑数。
 *
 * 用法：
 *   node training/build_sft_data.mjs                # 生成到 training/data/
 *   node training/build_sft_data.mjs --variants 3   # 每题几个候选
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, glmReady, glmConfig } from '../backend/glm.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const OUT_DIR = path.join(HERE, 'data');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const VARIANTS = Math.max(1, Math.min(5, Number(arg('--variants', 3))));

/** 从 constraint 里解析字数上限，解析不到返回 null（不做猜测） */
export function parseCharLimit(constraint) {
  if (!constraint) return null;
  const m = String(constraint).match(/(\d+)\s*(?:个)?字/);
  if (m) return Number(m[1]);
  if (/一句话|一句/.test(constraint)) return 40;   // 「一句话」按 40 字兜底
  return null;
}

/** 中文按字计，英文按词计——和一般「字数」直觉一致 */
export function charCount(text) {
  const s = String(text ?? '').trim();
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const words = (s.replace(/[\u4e00-\u9fff]/g, ' ').match(/[A-Za-z0-9]+/g) || []).length;
  return cjk + words;
}

const SUP = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

/** 归一化：只留中英文数字，统一小写。上标数字要先还原，否则 10⁸ 永远匹配不上 108 */
export function normalize(text) {
  return String(text ?? '')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, (c) => SUP[c])
    .replace(/[^0-9A-Za-z一-鿿]/g, '')
    .toLowerCase();
}

function bigrams(s) {
  if (!s) return new Set();
  if (s.length < 2) return new Set([s]);
  const out = new Set();
  for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * 参考要点覆盖度。
 * 用「大二元组重合 + 单字重合 + 数字命中」三者取最大，而不是精确子串 ——
 * 中文里「达芬奇」和「列奥纳多·达·芬奇」是同一个答案，精确匹配会把正确答案判掉。
 */
export function referenceCoverage(answer, reference) {
  const a = normalize(answer);
  const r = normalize(reference);
  if (!a || !r) return 0;
  const refBi = bigrams(r);
  const ansBi = bigrams(a);
  let hit = 0;
  for (const b of refBi) if (ansBi.has(b)) hit += 1;
  const biScore = refBi.size ? hit / refBi.size : 0;

  const refChars = new Set(r.split(''));
  let charHit = 0;
  for (const c of refChars) if (a.includes(c)) charHit += 1;
  const charScore = refChars.size ? charHit / refChars.size : 0;

  const numbers = (r.match(/\d{2,}/g) || []);
  const numberHit = numbers.some((n) => a.includes(n));

  return Math.max(biScore, charScore, numberHit ? 1 : 0);
}

/** 从题干/约束里解析「只能从这几个里选一个」的枚举标签 */
export function parseLabelOptions(prompt, constraint) {
  const isLabelTask = /三选一|标签|只给(类别|结论)|只能从/.test(String(constraint ?? ''));
  if (!isLabelTask) return [];
  const m = String(prompt ?? '').match(/[（(]([^（）()]{1,40}\/[^（）()]{1,40})[）)]/);
  if (!m) return [];
  const opts = m[1].split('/').map((x) => x.trim()).filter(Boolean);
  return opts.length >= 2 ? opts : [];
}

/**
 * 按题型分别校验。
 *
 * 为什么要分题型：不同题型的「正确答案空间」根本不同——
 *   - 标签题只有一个正确答案，答成一句话就是违反约束
 *   - 创意写作没有唯一答案，用「和参考句子的字符重合度」判对错是错的
 *   - 事实/推理题必须落在参考要点上，否则很可能是编造
 * 一刀切只会得到两个坏结果：把好样本丢掉，或者把坏样本放进来。
 */
export function validateAnswer({ answer, reference, constraint, prompt = '', task_type = '' }) {
  const reasons = [];
  const text = String(answer ?? '').trim();

  if (!text) reasons.push('空答案');
  if (text.length > 400) reasons.push(`答案过长（${text.length} 字符）`);
  if (/^(根据|按照|参考|以下是|这道题|题目要求)/.test(text)) reasons.push('出现元话语开头');

  // 1) 标签题：必须恰好命中枚举之一，且不能夹带解释
  const labels = parseLabelOptions(prompt, constraint);
  if (labels.length) {
    const norm = normalize(text);
    const hit = labels.find((l) => norm === normalize(l));
    if (!hit) reasons.push(`未按要求只给标签（可选：${labels.join('/')}）`);
  }

  // 2) 字数约束
  const limit = parseCharLimit(constraint);
  if (limit !== null && charCount(text) > limit) {
    reasons.push(`超出约束字数（${charCount(text)} > ${limit}）`);
  }

  // 3) 事实/推理题：必须落在参考要点上
  if (['事实问答', '逻辑推理'].includes(task_type)) {
    const cov = referenceCoverage(text, reference);
    if (cov < 0.3) reasons.push(`未覆盖参考要点（覆盖度 ${cov.toFixed(2)}）`);
  }

  // 4) 代码题：至少得是代码
  if (task_type === '代码生成' && !/(def |function |=>|return )/.test(text)) {
    reasons.push('未给出代码');
  }

  return { ok: reasons.length === 0, reasons };
}

const SYS = '你是一个严格遵守题目要求的助手。题目要求越具体，越要严格照做；不需要解释时直接给答案。';

function buildUserPrompt(item, n) {
  return [
    `题目：${item.prompt}`,
    item.reference ? `参考要点（答案必须覆盖，不得编造其它事实）：${item.reference}` : '',
    item.constraint ? `约束：${item.constraint}（必须严格遵守）` : '',
    '',
    `请生成 ${n} 个都能满足约束、但表达方式和详略略有差异的答案。要求：`,
    '- 每个答案都必须包含参考要点中的关键事实，不得编造',
    '- 严格遵守约束；约束要求简洁时，不要补充背景、不要分点罗列',
    '- 不要出现「根据参考要点」「答案是」「以下是」这类元话语',
    '- 只输出 JSON 数组，例如 ["答案1","答案2"]，不要输出其它任何文字',
  ].filter(Boolean).join('\n');
}

function extractJsonArray(raw) {
  const s = String(raw ?? '').trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = s.indexOf('[');
  const end = s.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const arr = JSON.parse(s.slice(start, end + 1));
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

async function main() {
  if (!glmReady) {
    console.error('需要 GLM 密钥（config.json 或 GLM_API_KEY），否则无法生成训练答案');
    process.exit(1);
  }

  const items = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompts_extra.json'), 'utf8'));
  const evalItems = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/prompts.json'), 'utf8'));

  // 训练/评测不泄漏：这两道闸门必须过，过不了直接终止
  const evalIds = new Set(evalItems.map((x) => x.id));
  const evalPrompts = new Set(evalItems.map((x) => x.prompt.trim()));
  const leak = items.filter((x) => evalIds.has(x.id) || evalPrompts.has(x.prompt.trim()));
  if (leak.length) {
    console.error(`训练题与评测集重叠 ${leak.length} 条，拒绝继续：${leak.map((x) => x.id).join(',')}`);
    process.exit(1);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const samples = [];
  const rejects = [];
  let calls = 0;

  for (const [i, item] of items.entries()) {
    process.stdout.write(`\r  生成中 ${i + 1}/${items.length}  ${item.id}   `);
    let candidates = [];
    try {
      calls += 1;
      const raw = await chat(buildUserPrompt(item, VARIANTS), {
        temperature: 0.8,
        maxTokens: 700,
        systemRole: SYS,
      });
      candidates = extractJsonArray(raw) ?? [];
      if (!candidates.length) rejects.push({ id: item.id, reason: 'JSON 解析失败', raw: String(raw).slice(0, 200) });
    } catch (e) {
      rejects.push({ id: item.id, reason: `调用失败：${e.message}` });
      continue;
    }

    for (const [j, answer] of candidates.entries()) {
      const check = validateAnswer({
        answer, reference: item.reference, constraint: item.constraint,
        prompt: item.prompt, task_type: item.task_type,
      });
      if (!check.ok) {
        rejects.push({ id: `${item.id}#${j + 1}`, reason: check.reasons.join('；'), answer: answer.slice(0, 120) });
        continue;
      }
      samples.push({
        id: `${item.id}#${j + 1}`,
        task_type: item.task_type,
        constraint: item.constraint ?? '',
        messages: [
          { role: 'system', content: SYS },
          { role: 'user', content: item.prompt },
          { role: 'assistant', content: String(answer).trim() },
        ],
        source: `distilled:${glmConfig.model}`,
      });
    }
  }
  process.stdout.write('\n');

  const contentHash = crypto
    .createHash('sha256')
    .update(JSON.stringify(samples.map((s) => [s.id, s.messages[2].content])))
    .digest('hex');

  const trainPath = path.join(OUT_DIR, 'train.jsonl');
  fs.writeFileSync(trainPath, samples.map((s) => JSON.stringify(s)).join('\n') + '\n', 'utf8');

  const manifest = {
    generated_at: new Date().toISOString(),
    task: 'constraint-following',
    teacher_model: glmConfig.model,
    source_prompt_file: 'data/prompts_extra.json',
    prompt_count: items.length,
    variants_requested: VARIANTS,
    samples_kept: samples.length,
    samples_rejected: rejects.length,
    glm_calls: calls,
    content_hash: contentHash,
    provenance: 'distilled（GLM 生成，非人工标注）',
    eval_isolation: {
      eval_file: 'data/prompts.json',
      eval_prompts: evalItems.length,
      id_overlap: 0,
      prompt_overlap: 0,
    },
    by_task_type: samples.reduce((acc, s) => {
      acc[s.task_type] = (acc[s.task_type] ?? 0) + 1;
      return acc;
    }, {}),
    avg_chars: Number((samples.reduce((n, s) => n + charCount(s.messages[2].content), 0) / Math.max(1, samples.length)).toFixed(1)),
    // 约束是否真的被守住：字数型题目逐条复算，方便一眼看出数据质量
    constraint_check: {
      with_char_limit: samples.filter((s) => parseCharLimit(s.constraint) !== null).length,
      max_chars_over_limit: samples.reduce((mx, s) => {
        const lim = parseCharLimit(s.constraint);
        if (lim === null) return mx;
        return Math.max(mx, charCount(s.messages[2].content) - lim);
      }, 0),
    },
  };

  fs.writeFileSync(path.join(OUT_DIR, 'train_manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'rejects.json'), JSON.stringify(rejects, null, 2), 'utf8');

  console.log(`\n训练集：${samples.length} 条（丢弃 ${rejects.length} 条），GLM 调用 ${calls} 次`);
  console.log(`平均答案长度：${manifest.avg_chars} 字`);
  console.log(`题型分布：${JSON.stringify(manifest.by_task_type)}`);
  console.log(`内容哈希：${contentHash.slice(0, 16)}`);
  console.log(`输出：${path.relative(ROOT, trainPath)}`);
}

// 只有直接执行才跑主流程。否则单元测试 import 这个模块时会顺带发起 40 次模型调用 ——
// 这类「import 即副作用」的脚本最难排查，必须从源头堵住。
const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  main().catch((e) => {
    console.error('失败：', e.message);
    process.exit(1);
  });
}
