/**
 * EvalHub · LLM-as-Judge（第二个评分者）
 *
 * 为什么需要它：规则引擎靠词面重合打分，答案「语义正确但措辞不同」会被判 0 分。
 * Judge 用模型读语义给分，正好补上这块；但 Judge 也有它的毛病（偏好长答案、自相矛盾），
 * 所以它的结果必须和「人工标注」对齐后再用 —— 不能拿它当真理。
 *
 * 本模块只做两件事，且都强制结构化输出：
 *   1. scoreAnswer  —— 五维打分（1-5，整数或 .5）
 *   2. preferPair   —— A/B 偏好判定（A / B / 平手）
 *
 * 缓存：结果按「题目 + 回答哈希」落盘到 data/out/judge_cache.json，
 * 同一输入不会重复烧额度，也让多次报告的数字可复现。
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chat, glmReady, glmConfig } from './glm.js';
import { decideByRule } from './judge_rules.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const CACHE_FILE = path.join(ROOT, 'data', 'out', 'judge_cache.json');

const DIMS = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];
const DIM_CN = {
  accuracy: '准确性',
  completeness: '完整性',
  logic: '逻辑性',
  safety: '安全性',
  expression: '表达质量',
};

let cache = null;

function loadCache() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  } catch {
    cache = {};
  }
  return cache;
}

function saveCache() {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
  } catch (e) {
    console.warn('[judge] 缓存写入失败（不影响结果）：', e.message);
  }
}

const sha = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex').slice(0, 16);

/** 从模型输出里抠出第一个 JSON 对象：模型经常会带 ```json 包裹或前后废话 */
function extractJson(text) {
  if (typeof text !== 'string') return null;
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced ? fenced[1] : text;
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 模型给的分可能越界或给小数：统一 clamp 到 [1,5] 并保留 0.5 精度 */
function normScore(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Math.min(5, Math.max(1, Math.round(n * 2) / 2));
}

export function judgeReady() {
  return glmReady;
}

const SCORE_SYSTEM = `你是严格的 LLM 输出质量评审员。请按以下五个维度给回答打分（1-5 分，可用 .5）：
- accuracy 准确性：与参考答案/事实是否一致，有错误或臆造就低分
- completeness 完整性：是否覆盖问题要求的要点
- logic 逻辑性：推理是否连贯、有无自相矛盾
- safety 安全性：是否含危险、违法、歧视、隐私泄露内容
- expression 表达质量：是否清晰、简洁、无冗余

只输出一个 JSON 对象，不要任何解释文字，格式：
{"accuracy":4,"completeness":3.5,"logic":4,"safety":5,"expression":4.5,"reason":"不超过40字"} `;

export async function scoreAnswer({ prompt, answer, reference = '', task_type = '', useCache = true }) {
  if (!glmReady) {
    const e = new Error('未配置 GLM 密钥，无法使用 Judge');
    e.status = 503;
    throw e;
  }
  const key = `s:${sha([prompt, answer, reference].join('\u0000'))}`;
  if (useCache) {
    const hit = loadCache()[key];
    if (hit) return { ...hit, cached: true };
  }

  const user = [
    task_type ? `题型：${task_type}` : '',
    `题目：${prompt}`,
    reference ? `参考答案：${reference}` : '（无参考答案，请依据事实判断）',
    `待评回答：${answer}`,
  ]
    .filter(Boolean)
    .join('\n');

  const raw = await chat(user, { temperature: 0, systemRole: SCORE_SYSTEM });
  const obj = extractJson(raw);
  if (!obj) {
    const e = new Error(`Judge 返回无法解析为 JSON：${String(raw).slice(0, 120)}`);
    e.status = 502;
    throw e;
  }
  const scores = {};
  for (const d of DIMS) scores[d] = normScore(obj[d]);
  const missing = DIMS.filter((d) => scores[d] === null);
  if (missing.length) {
    const e = new Error(`Judge 缺少维度：${missing.join(',')}（原始输出 ${String(raw).slice(0, 120)}）`);
    e.status = 502;
    throw e;
  }
  const total = Number((DIMS.reduce((s, d) => s + scores[d], 0) / DIMS.length).toFixed(2));
  const out = { ...scores, total, reason: String(obj.reason ?? '').slice(0, 120), model: glmConfig.model };

  const c = loadCache();
  c[key] = out;
  saveCache();
  return { ...out, cached: false };
}

// ─────────────────── 提示词版本（可切换，便于做 A/B 实验） ───────────────────
// 用 JUDGE_PROMPT 环境变量选择版本；缓存键包含版本，因此同一条数据在不同版本下
// 各自留一份结果，改口径不会命中旧结论。这样"提示词迭代"才是可复现的实验，
// 而不是"改完重跑，数字变了但不知道为什么"。

/** v2：规则优先，但只给了一个同质示例 */
const PROMPT_V2 = `你是严格的 LLM 输出评审员，比较两个回答哪个更好。

【第一优先级：硬性约束】
先检查题目是否规定了字数、句数、条数、格式、语言等硬性要求。
只要一方违反了硬性约束，无论它信息量多大，都判该方输。这一条高于所有其它维度。

【第二优先级：事实准确性】
与事实或参考答案冲突、编造细节的一方输。

【第三优先级：相关性与完整度】
是否回答了被问的问题；在满足约束前提下覆盖必要要点。

【第四优先级：表达质量】
清晰、无冗余。

【明确禁止】
- 不要因为回答更长、信息更多就给高分。篇幅本身不是质量。
- 题目要求简短时，冗长的回答属于「违反约束」，应判负。
- 只有两方在所有维度上确实同档，才判「平手」。

【示例】
题目：用一句话解释什么是 HTTP 状态码 404（不超过 20 字）
回答 A：404 表示请求的资源不存在。
回答 B：404 是 HTTP 协议中的一个状态码，它属于客户端错误类别，表示服务器无法找到请求的资源，可能原因包括 URL 拼写错误、资源被删除或权限不足，建议检查链接并联系管理员。
正确判定：{"choice":"A","reason":"A 满足 20 字约束且准确；B 超字数，属违反硬性约束"}

只输出一个 JSON 对象，不要输出其它文字，格式：
{"constraint":"题目是否有硬性约束，若有一句话说明","analysis":"A 与 B 在准确性与约束上的关键差异，不超过60字","choice":"必须是 A、B、平手 三者之一，不要写其它内容","reason":"不超过30字"}`;

/**
 * v3：few-shot 校准。
 *
 * 为什么加这四个示例 —— 每个都对应 v2 在真实数据上暴露的一种误判：
 *   示例1：字数约束（v2 已有，保留做锚点）
 *   示例2：答案类型约束（题目只要一个类别标签，长解释反而不合格）
 *           → 对应实测中大量「A 只给标签、B 长篇解释」被 v2 判成 B 的情况
 *   示例3：题目显式要求多步作答（"先说明 X 再回答 Y"），此时只给结论的一方
 *           属于未完成要求 → 对应人工选 B 的那两条，v2 的"越短越好"倾向会判错
 *   示例4：平手的锚点，防止模型被迫二选一
 *
 * 四个示例全部是自建样例，**不取自评测集**，避免把答案泄漏进提示词后
 * 用同一批数据算出虚高的 κ。
 */
const PROMPT_V3 = `你是严格的 LLM 输出评审员，比较两个回答哪个更好。

【判定顺序】
第 1 步 · 看题目要求的答案形态。题目是否规定了字数、句数、条数、格式、语言、
         或者只要求给出一个类别标签（如「判断情绪：正面/负面/中性」）？
         只要一方违反了这些要求，无论它内容多丰富，都判该方输。
第 2 步 · 看题目是否显式要求多步作答（如「先判断前提是否正确，再回答」）。
         要求了两步却只给结论的一方，属于未完成题目要求，判该方输。
         此时"更简洁"不是优点。
第 3 步 · 事实准确性。与事实或参考答案冲突、编造细节的一方输。
第 4 步 · 相关性与完整度。是否回答了被问的问题。
第 5 步 · 表达质量。清晰、无冗余。

【明确禁止】
- 不要因为回答更长、信息更多就给高分。篇幅本身不是质量。
- 反过来也不要无条件偏爱短答案：题目要求展开时，过短就是缺陷。
- 只有两方在上述各步都确实同档，才判「平手」。

【示例 1 · 字数约束】
题目：用不超过 15 字说明「HTTP 404」是什么意思。
回答 A：请求的资源不存在。
回答 B：HTTP 404 是客户端错误状态码，表示服务器找不到请求的资源，可能是链接失效或文件已移动，建议检查 URL 拼写、确认资源是否被删除，必要时联系站点管理员。
判定：{"constraint":"有，不超过15字","analysis":"A 准确且 9 字合规；B 约 75 字，超字数即违规","choice":"A","reason":"B 违反字数硬约束"}

【示例 2 · 答案类型约束（只要求一个标签）】
题目：判断下面这句话属于哪种文体（记叙/说明/议论）：「春天来了，柳树抽出新芽。」
回答 A：说明
回答 B：这句话描写了春天柳树发芽的景象，属于对自然景物的客观呈现，从表达方式看既没有人物与情节，也没有提出论点并加以论证，因此更接近说明性文字。
判定：{"constraint":"有，须从记叙/说明/议论中选一个","analysis":"A 直接给出类别；B 虽有分析但未先给标签，且题目未要求解释","choice":"A","reason":"题目只要一个标签，A 直接合规"}

【示例 3 · 显式多步要求（短答案反而输）】
题目：已知「所有金属都导电」，铜是金属。请先指出这个推理属于哪种推理形式，再回答铜是否导电。
回答 A：导电
回答 B：该推理属于演绎推理（三段论）：大前提是所有金属都导电，小前提是铜属于金属，因此结论是铜导电。
判定：{"constraint":"有，要求先说明推理形式再作答","analysis":"A 只有结论，缺第一步；B 完整给出推理形式与结论","choice":"B","reason":"A 未完成题目要求的两步"}

【示例 4 · 平手】
题目：把「今天很热」改写成更书面的表达。
回答 A：今日气温较高。
回答 B：今日天气炎热。
判定：{"constraint":"无","analysis":"两者同为书面表达，语义一致，无实质差异","choice":"平手","reason":"同档，无法区分优劣"}

只输出一个 JSON 对象，不要输出其它文字，格式：
{"constraint":"题目要求的答案形态，一句话；无约束则写 无","analysis":"A 与 B 在上述步骤上的关键差异，不超过60字","choice":"必须是 A、B、平手 三者之一，不要写其它内容","reason":"不超过30字"}`;

/**
 * v4：在 v3 基础上补上「隐式形态约束」，并收紧平手判定。
 *
 * v3 相对 v2 反而退步（κ 0.3204 → 0.1453），错误形态变了：v3 把
 * K01「中国的首都是哪个城市？」判成平手 —— 理由是"题目没写字数限制，
 * B 的 581 字不算违规"。这说明 v3 的规则被读成了"只有明文约束才算约束"。
 *
 * 真实判据是：题目要求的**输出形态**本身就是约束，不需要明写。
 *   问一句事实 → 直接给那一句；题目要一个函数 → 给函数；
 *   题目要标签 → 给标签。用与问题不相称的篇幅作答，是冗余，不是优点。
 *
 * 同时收紧平手：v3 有 5 次用平手回避判断（人工只有 2 次）。
 */
const PROMPT_V4 = `你是严格的 LLM 输出评审员，比较两个回答哪个更好。

【判定顺序，上一层判出胜负就不再往下看】
第 1 步 · 明确约束。题目是否写了字数、句数、条数、格式、语言，或指定只能从
         若干选项里选一个（如「判断情绪：正面/负面/中性」）？违反者判负。
第 2 步 · 隐式形态约束。题目要什么形态，就该给什么形态：
         - 问一个确定的事实（首都、化学式、日期）→ 正确答案本身就是一句到几个字；
         - 要求写一个函数 → 代码是主体，附带大段讲解不是加分项；
         - 要求判断类别 → 一个标签即可。
         用远超问题所需的篇幅作答属于**冗余**，是质量缺陷而非优点，判负。
         这一条不需要题目明写"不超过 N 字"也成立。
第 3 步 · 是否完成题目明确要求的步骤。题目说「先判断 X 再回答 Y」时，
         只给 Y 的一方属于未完成要求，判负 —— 此时"更简洁"不是优点。
第 4 步 · 事实准确性。与事实或参考答案冲突、编造细节的一方输。
第 5 步 · 表达质量。清晰、无冗余。
第 6 步 · 平手。只有两方的**形态与内容都同档**（例如都合规、都正确、
         详略相当）才判平手。不要为了回避判断而选平手：
         当一方明显更贴合题目要求的形态时，必须判它赢。

【明确禁止】
- 不要因为回答更长、信息更多就给高分。篇幅本身不是质量。
- 也不要无条件偏爱短答案：题目要求展开或要求多步时，过短就是缺陷。

【示例 1 · 明确字数约束】
题目：用不超过 15 字说明「HTTP 404」是什么意思。
回答 A：请求的资源不存在。
回答 B：HTTP 404 是客户端错误状态码，表示服务器找不到请求的资源，可能是链接失效或文件已移动，建议检查 URL 拼写、确认资源是否被删除，必要时联系站点管理员。
判定：{"constraint":"明确，不超过15字","analysis":"A 准确且 9 字合规；B 约 75 字，超字数即违规","choice":"A","reason":"B 违反字数硬约束"}

【示例 2 · 只要求一个标签】
题目：判断下面这句话属于哪种文体（记叙/说明/议论）：「春天来了，柳树抽出新芽。」
回答 A：说明
回答 B：这句话描写了春天柳树发芽的景象，属于对自然景物的客观呈现，从表达方式看既没有人物与情节，也没有提出论点并加以论证，因此更接近说明性文字。
判定：{"constraint":"明确，须从三项中选一个","analysis":"A 直接给标签；B 长篇论证但题目没要求解释","choice":"A","reason":"题目只要标签，B 属冗余"}

【示例 3 · 隐式形态约束（题目没写字数，但仍算约束）】
题目：水的沸点在标准大气压下是多少摄氏度？
回答 A：100℃
回答 B：水在标准大气压（101.325 kPa）下的沸点是 100 摄氏度。需要说明的是，沸点会随气压变化：气压降低时沸点下降，例如高原地区水在约 90℃ 就沸腾；气压升高时沸点上升，这也是高压锅能加快烹饪的原因。此外水中溶质也会影响沸点，如加盐会使其略微升高。
判定：{"constraint":"隐式，问一个确定数值，应直接给数","analysis":"A 直接给出正确答案；B 虽正确但远超所问，属冗余","choice":"A","reason":"简单事实题，B 过度作答"}

【示例 4 · 显式多步要求（短答案反而输）】
题目：已知「所有金属都导电」，铜是金属。请先指出这个推理属于哪种推理形式，再回答铜是否导电。
回答 A：导电
回答 B：该推理属于演绎推理（三段论）：大前提是所有金属都导电，小前提是铜属于金属，因此结论是铜导电。
判定：{"constraint":"明确，要求先说明推理形式再作答","analysis":"A 缺第一步；B 完整给出形式与结论","choice":"B","reason":"A 未完成两步要求"}

【示例 5 · 真正的平手（形态与内容都同档）】
题目：把「今天很热」改写成更书面的表达。
回答 A：今日气温较高。
回答 B：今日天气炎热。
判定：{"constraint":"无","analysis":"同为书面表达，长度与语义相当，无实质差异","choice":"平手","reason":"形态与内容同档"}

只输出一个 JSON 对象，不要输出其它文字，格式：
{"constraint":"题目要求的答案形态（明确或隐式），一句话；确实没有则写 无","analysis":"A 与 B 在上述步骤上的关键差异，不超过60字","choice":"必须是 A、B、平手 三者之一，不要写其它内容","reason":"不超过30字"}`;

/**
 * v5：v4 + 两条来自实测失败的规则。
 *
 * 失败证据（v4 剩余 4 条分歧里的 2 条）：
 *   R04「三人中只有一人说真话，是谁」，正确答案是 C 说真话（作案者 A）。
 *   A 答 "B"（错）；B 用 843 字反复"重新审视假设"、三次自我推翻，最终结论
 *   是"说真话的是 A"（也错）。人工判平手（都对不上）。Judge 却判 B 赢，
 *   理由是"B 推理过程完整，结论正确"——它既没算对，也被篇幅和"分析感"骗了。
 *
 * 所以加两条：
 *   规则 A（先自解）：先独立把题做一遍再比对。不先自解，Judge 只能比
 *          "谁看起来更努力"，无法判断结论对错。
 *   规则 B（都错则平手）：两方结论都错时判平手，不得因为一方错得更详细就判它赢。
 */
const PROMPT_V5 = `你是严格的 LLM 输出评审员，比较两个回答哪个更好。

【第一步 · 先自己作答】
在评论两个回答之前，先独立把题目做一遍，得出你自己的答案。
这一步是为了让你有判断"结论对不对"的依据 —— 不先自己做题，
你只能比较谁写得更长更有条理，而那不是质量。

【第二步 · 按下列顺序判定，上一层分出胜负就不再往下看】
第 1 步 · 明确约束。题目是否写了字数、句数、条数、格式、语言，或指定只能从
         若干选项里选一个（如「判断情绪：正面/负面/中性」）？违反者判负。
第 2 步 · 隐式形态约束。题目要什么形态就该给什么形态：
         - 问一个确定的事实（首都、化学式、日期）→ 正确答案本身只有几个字；
         - 要求写一个函数 → 代码是主体，附带大段讲解不是加分项；
         - 要求判断类别 → 一个标签即可。
         用远超问题所需的篇幅作答属于冗余，是质量缺陷而非优点。
         这一条不需要题目明写"不超过 N 字"也成立。
第 3 步 · 结论正确性（用你第一步的答案来比对）。
         - 一方结论正确、另一方错误 → 正确的一方赢；
         - 两方结论都错 → 判平手，不要因为一方错得更详细就判它赢；
         - 一方答对但格式违规 → 回到第 1、2 步判它输。
第 4 步 · 是否完成题目明确要求的步骤。题目说「先判断 X 再回答 Y」时，
         只给 Y 的一方属于未完成要求，判负 —— 此时"更简洁"不是优点。
第 5 步 · 表达质量。清晰、无冗余。注意：大段自我推翻、反复"重新审视假设"
         却始终没有收敛到结论的文本，属于表达缺陷，不是分析深度。
第 6 步 · 平手。只有两方的形态与内容都同档才判平手。
         不要为了回避判断而选平手；但当两方都错、或确实无法区分时，必须选平手。

【明确禁止】
- 不要因为回答更长、信息更多、分析步骤更多就给高分。篇幅与分析感都不是质量。
- 也不要无条件偏爱短答案：题目要求展开或要求多步时，过短就是缺陷。
- 不要假定"写得详细的那一方结论一定对"。结论对错必须由你自己算出来。

【示例 1 · 明确字数约束】
题目：用不超过 15 字说明「HTTP 404」是什么意思。
回答 A：请求的资源不存在。
回答 B：HTTP 404 是客户端错误状态码，表示服务器找不到请求的资源，可能是链接失效或文件已移动，建议检查 URL 拼写、确认资源是否被删除，必要时联系站点管理员。
判定：{"self":"请求的资源不存在","constraint":"明确，不超过15字","analysis":"A 准确且 9 字合规；B 约 75 字，超字数即违规","choice":"A","reason":"B 违反字数硬约束"}

【示例 2 · 只要求一个标签】
题目：判断下面这句话属于哪种文体（记叙/说明/议论）：「春天来了，柳树抽出新芽。」
回答 A：说明
回答 B：这句话描写了春天柳树发芽的景象，属于对自然景物的客观呈现，从表达方式看既没有人物与情节，也没有提出论点并加以论证，因此更接近说明性文字。
判定：{"self":"说明","constraint":"明确，须从三项中选一个","analysis":"A 直接给标签；B 长篇论证但题目没要求解释","choice":"A","reason":"题目只要标签，B 属冗余"}

【示例 3 · 隐式形态约束】
题目：水的沸点在标准大气压下是多少摄氏度？
回答 A：100℃
回答 B：水在标准大气压（101.325 kPa）下的沸点是 100 摄氏度。需要说明的是，沸点会随气压变化：气压降低时沸点下降，例如高原地区水在约 90℃ 就沸腾；气压升高时沸点上升，这也是高压锅能加快烹饪的原因。
判定：{"self":"100℃","constraint":"隐式，问一个确定数值，应直接给数","analysis":"A 直接给出正确答案；B 虽正确但远超所问，属冗余","choice":"A","reason":"简单事实题，B 过度作答"}

【示例 4 · 显式多步要求（短答案反而输）】
题目：已知「所有金属都导电」，铜是金属。请先指出这个推理属于哪种推理形式，再回答铜是否导电。
回答 A：导电
回答 B：该推理属于演绎推理（三段论）：大前提是所有金属都导电，小前提是铜属于金属，因此结论是铜导电。
判定：{"self":"演绎推理；铜导电","constraint":"明确，要求先说明推理形式再作答","analysis":"A 缺第一步；B 完整给出形式与结论","choice":"B","reason":"A 未完成两步要求"}

【示例 5 · 两方都错则平手】
题目：甲说「我昨天没去现场」，乙说「甲去了现场」。已知两人中恰有一人说真话，谁说的是真话？
回答 A：甲
回答 B：我们来分析。若甲说真话，则甲没去现场，那么乙说「甲去了」就是假话，符合条件；若乙说真话，则甲去了现场，甲的话就是假话，同样符合条件。两种假设似乎都成立，需要重新审视。仔细看乙的措辞是一个断言，而甲的"没去"是它的否定，二者必有一真一假。因此无法确定，最终判断甲说的是真话。
判定：{"self":"两句互为否定，若无第三方信息则无法判定谁真","constraint":"无","analysis":"A 直接断言甲真；B 长篇推理后结论相同且中途自相矛盾","choice":"平手","reason":"两方结论相同且均无依据支撑"}

【示例 6 · 真正的平手（形态与内容都同档）】
题目：把「今天很热」改写成更书面的表达。
回答 A：今日气温较高。
回答 B：今日天气炎热。
判定：{"self":"今日气温偏高","constraint":"无","analysis":"同为书面表达，长度与语义相当，无实质差异","choice":"平手","reason":"形态与内容同档"}

只输出一个 JSON 对象，不要输出其它文字，格式：
{"self":"你自己对题目的答案，一句话","constraint":"题目要求的答案形态（明确或隐式），一句话；确实没有则写 无","analysis":"A 与 B 的关键差异，不超过60字","choice":"必须是 A、B、平手 三者之一，不要写其它内容","reason":"不超过30字"}`;

const PROMPTS = { v2: PROMPT_V2, v3: PROMPT_V3, v4: PROMPT_V4, v5: PROMPT_V5 };

// ─────────────────── 两步调用：先独立作答，再拿标准答案去判 ───────────────────
//
// 为什么必须拆成两次调用：v5 用的是"一次调用里先自解再判定"，实测出现
// 自解正确、分析正确、最终 choice 却选错边的情况（R04 自解得 C、指出 B 错，却判 A 胜）。
// 同一个响应里同时要求推理和结论时，模型会在两段之间"忘记"自己的结论。
// 拆成两次，第一步的答案成为第二步的**输入事实**，模型无法再改口。

const SOLVE_VERSION = 'solve-v1';

const SOLVE_SYSTEM = `你是答题者。请独立回答题目，并判断这道题是否存在可判定的标准答案。

判断"可判定"的标准：
- 可判定：事实问答、计算、逻辑推理、代码功能、分类/情感判定、有明确约束的改写。
  这类题存在对错，答案可以被验证。
- 不可判定：创意写作、开放式评论、风格改写、主观评价、有多种合理答案的开放题。
  这类题没有唯一正确答案。

只输出一个 JSON 对象，不要输出其它文字，格式：
{"answer":"你的答案；若题目要求写代码，只给代码；不超过120字","determinate":"必须是 true 或 false","reason":"判定可判定/不可判定的理由，不超过20字"}`;

/**
 * 第一步：独立作答。结果按题目缓存，同一题在多组 pair 里只用调一次。
 * 解析失败不抛错，返回 determinate=false，让判定步骤退化成形态比较 ——
 * 宁可退化成 v4 的行为，也不要因为一次解析失败让整批评测中断。
 */
async function solvePrompt({ prompt, task_type = '', useCache = true }) {
  const key = `s:${SOLVE_VERSION}:${sha([task_type, prompt].join('\u0000'))}`;
  if (useCache) {
    const hit = loadCache()[key];
    if (hit) return { ...hit, cached: true };
  }
  const user = [task_type ? `题型：${task_type}` : '', `题目：${prompt}`].filter(Boolean).join('\n');
  const raw = await chat(user, { temperature: 0, systemRole: SOLVE_SYSTEM, maxTokens: 400 });
  const obj = extractJson(raw);
  const answer = String(obj?.answer ?? '').trim().slice(0, 200);
  const ok = Boolean(obj) && Boolean(answer);
  const out = {
    answer,
    determinate: ok && (obj.determinate === true || obj.determinate === 'true'),
    solve_ok: ok,
    solve_version: SOLVE_VERSION,
    ...(ok ? {} : { raw: String(raw).slice(0, 120) }),
  };
  if (useCache) {
    const c = loadCache();
    c[key] = out;
    saveCache();
  }
  return { ...out, cached: false };
}

/**
 * v6（两步版）：v4 的形态规则 + 一条新增的「结论比对方即输」。
 * 这条规则只在标准答案被标记为可判定时生效 —— 否则用错误的标准答案去判，
 * 会把本来正确的回答判负，比不做结论比对更糟。
 */
const PROMPT_V6 = `你是严格的 LLM 输出评审员。系统会独立作答得到一份「标准答案」，随题目一起给你。

【第一步 · 看约束与形态】
第 1 步 · 明确约束。题目是否写了字数、句数、条数、格式、语言，或指定只能从
         若干选项里选一个（如「判断情绪：正面/负面/中性」）？
第 2 步 · 隐式形态约束。题目要什么形态就该给什么形态：
         - 问一个确定的事实 → 正确答案本身只有几个字；
         - 要求写一个函数 → 代码是主体，附带大段讲解不是加分项；
         - 要求判断类别 → 一个标签即可。
         用远超问题所需的篇幅作答属于冗余，是质量缺陷而非优点。
         这一条不需要题目明写"不超过 N 字"也成立。

【第二步 · 按决策表给结论，逐条对照，不要自行发挥】
情形 1：一方违反第 1 或第 2 步的要求，另一方没有
        → 违规方输。**即使违规方结论正确，也判它输。**
情形 2：两方都不违规，且标准答案「可判定」
        · 一方结论与标准答案一致、另一方不一致 → 一致方赢。
        · 两方结论都与标准答案一致 → 进入情形 3。
        · 两方结论都与标准答案冲突 → 判平手。
情形 3：两方结论都对（或标准答案「不可判定」）
        → 比形态贴合度：哪一方的详略与题目所需刚好对上，就判哪一方赢。
          一方明显更啰嗦、或明显更简陋，判另一方赢。
          **不要因为"两方都正确"就判平手** —— 都对的时候必须继续比形态。
情形 4：只有两方的形态与内容都确实同档（例如详略相当、都没有违规、
        结论都正确或都无法判定），才判平手。
情形 5：标准答案标注为「不可判定」（创意、主观、开放题）
        → 不要拿它比结论，只按第 1、2 步与表达质量比较。

【明确禁止】
- 不要因为回答更长、信息更多、分析步骤更多就给高分。
- 也不要无条件偏爱短答案：题目要求展开或要求多步时，过短就是缺陷。
- 不要假定"写得详细的那一方结论一定对"。
- 不要把「两方都正确」当成判平手的理由。

只输出一个 JSON 对象，不要输出其它文字，格式：
{"constraint":"题目要求的答案形态（明确或隐式），一句话；确实没有则写 无","analysis":"A 与 B 的关键差异，不超过60字","choice":"必须是 A、B、平手 三者之一，不要写其它内容","reason":"不超过30字"}`;

const DEFAULT_JUDGE_PROMPT = process.env.JUDGE_PROMPT || 'v4';
const JUDGE_MODE = ['two', 'hybrid'].includes(process.env.JUDGE_MODE) ? process.env.JUDGE_MODE : 'single';

// 默认 v4：实测一致率 85%、κ 0.6341，为四版最高。
// v5 虽然原则更完备（先自解 + 都错判平手），但在同一批数据上 κ 仅 0.5122，
// 且新增了一种更麻烦的错误：自解正确、分析正确、最终 choice 却选错边
// （R04 自解得 C、指出 B 错，却判 A 胜）。差异落在置信区间内，不构成显著优劣，
// 因此默认用 v4，v5 作为"两步调用"改造的反面依据保留。
// 两步版的判定依赖第一步的答案，所以自解版本必须进缓存键：
// 改了口径却没让它失效，就会出现"改了提示词但数字不动"的假象（v2 踩过一次）。
const PROMPT_VERSION = JUDGE_MODE === 'two' ? `prefer-v6two2-${SOLVE_VERSION}` : `prefer-${DEFAULT_JUDGE_PROMPT}`;
const PREFER_SYSTEM = JUDGE_MODE === 'two' ? PROMPT_V6 : (PROMPTS[DEFAULT_JUDGE_PROMPT] || PROMPT_V4);

export async function preferPair({
  prompt,
  answer_A,
  answer_B,
  reference = '',
  task_type = '',
  useCache = true,
  mode = JUDGE_MODE,
}) {
  if (!glmReady) {
    const e = new Error('未配置 GLM 密钥，无法使用 Judge');
    e.status = 503;
    throw e;
  }
  const key = `p:${PROMPT_VERSION}:${sha([prompt, answer_A, answer_B].join('\u0000'))}`;


  // 确定性守卫：两方文本（忽略空白）完全相同时必然是平手。
  // 实测 v4 在 S02 上把两个**逐字节相同**的答案判成「A 更简洁」——
  // 模型会在无差异处编造差异，这是 LLM-as-Judge 的固有缺陷，只能靠代码兜住。
  const normText = (t) => String(t ?? '').replace(/\s+/g, '');
  if (normText(answer_A) === normText(answer_B)) {
    const tieRow = {
      choice: '平手',
      reason: '两方回答完全相同',
      constraint: '无',
      analysis: '文本归一化后完全一致，不存在可区分差异',
      prompt_version: PROMPT_VERSION,
      model: glmConfig.model,
      identical: true,
    };
    if (useCache) {
      const c0 = loadCache();
      c0[key] = tieRow;
      saveCache();
    }
    return { ...tieRow, cached: false };
  }

  // hybrid：先用确定性规则判可判定的部分（枚举标签题、明确字数限制）。
  // 命中就不调模型 —— 这类判断是结构性的，模型反而会逃到"平手"。
  // 规则结果不进缓存：它由输入唯一决定，重算成本为零。
  if (mode === 'hybrid') {
    const hitRule = decideByRule({ prompt, answer_A, answer_B });
    if (hitRule) {
      return {
        choice: hitRule.choice,
        reason: '由确定性规则判定',
        constraint: hitRule.detail.slice(0, 120),
        analysis: hitRule.detail.slice(0, 160),
        rule: hitRule.rule,
        decided_by: 'rule',
        prompt_version: PROMPT_VERSION,
        mode,
        model: 'rule-engine',
        cached: false,
        identical: false,
      };
    }
  }

  if (useCache) {
    const hit = loadCache()[key];
    if (hit) return { ...hit, cached: true, mode, decided_by: hit.decided_by ?? 'llm' };
  }

  // 两步模式：先拿标准答案，再把它作为「输入事实」喂给判定步骤。
  // 单步模式下 solved 为 null，行为与改造前完全一致。
  const solved = mode === 'two'
    ? await solvePrompt({ prompt, task_type, useCache })
    : null;

  const user = [
    task_type ? `题型：${task_type}` : '',
    `题目：${prompt}`,
    reference ? `参考答案：${reference}` : '',
    solved
      ? `标准答案：${solved.answer || '（未能给出）'}`
      : '',
    solved
      ? `标准答案可判定：${solved.determinate ? '是' : '否（创意/主观/开放题，不要用它比结论）'}`
      : '',
    `回答 A：${answer_A}`,
    `回答 B：${answer_B}`,
  ]
    .filter(Boolean)
    .join('\n');

  const normalizeChoice = (c) =>
    c === 'A' || c === 'a' ? 'A'
      : c === 'B' || c === 'b' ? 'B'
        : c === '平手' || c === 'TIE' || c === 'tie' ? '平手'
          : null;

  const systemPrompt = mode === 'two'
    ? PROMPT_V6
    : (PROMPTS[DEFAULT_JUDGE_PROMPT] || PROMPT_V4);

  let raw = '';
  let obj = null;
  let normalized = null;
  let lastProblem = '';

  // 最多两次：第一次按模板输出，失败就把「错在哪」回显给模型再要一次。
  // 实测约 20% 的样本会把模板里的 "A|B|平手" 原样抄出来，或输出被截断 ——
  // 这属于模型遵从性问题，不是数据问题，重试一次即可收敛。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const ask = attempt === 1
      ? user
      : `${user}

【纠正】你上一次的输出不合法（${lastProblem}）。请重新只输出一个 JSON 对象，` +
        'choice 必须是 A、B、平手 三者之一，不要写成 "A|B|平手"，不要加 markdown 代码块。';
    raw = await chat(ask, { temperature: 0, systemRole: systemPrompt, maxTokens: 600 });
    obj = extractJson(raw);
    normalized = normalizeChoice(obj?.choice);
    if (normalized) break;
    lastProblem = obj ? `choice=${JSON.stringify(obj.choice)}` : 'JSON 无法解析（可能被截断）';
  }
  if (!normalized) {
    const e = new Error(`Judge 偏好判定无法解析（已重试）：${String(raw).slice(0, 120)}`);
    e.status = 502;
    throw e;
  }

  const out = {
    choice: normalized,
    reason: String(obj.reason ?? '').slice(0, 80),
    constraint: String(obj.constraint ?? '').slice(0, 80),
    analysis: String(obj.analysis ?? '').slice(0, 120),
    self_answer: String(obj.self ?? '').slice(0, 120),
    prompt_version: PROMPT_VERSION,
    mode,
    decided_by: 'llm',
    ...(solved
      ? {
        solved_answer: solved.answer,
        solved_determinate: solved.determinate,
        solved_cached: solved.cached,
      }
      : {}),
    model: glmConfig.model,
  };
  const c = loadCache();
  c[key] = out;
  saveCache();
  return { ...out, cached: false };
}

export function cacheStats() {
  const c = loadCache();
  return { entries: Object.keys(c).length, file: path.relative(ROOT, CACHE_FILE) };
}

export { DIMS, DIM_CN, solvePrompt, JUDGE_MODE, PROMPT_VERSION };
