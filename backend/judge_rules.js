/**
 * EvalHub · 确定性判优规则（hybrid judge 的前置层）
 *
 * 为什么需要它：实测发现，凡是"题目要求的形态"与"回答形态"的匹配问题，
 * 模型都能在 analysis 里写对，却在 final choice 上逃到"平手"
 * （E02 自己写下"题目只要求判断情绪类型"，仍然判平手）。
 * 这类判断不需要语言模型 —— 它是结构性的，用正则和长度就能算。
 *
 * 设计原则（重要，别乱加规则）：
 *   1. 只在**高置信**时短路，宁可漏判交给模型，也不能错判。
 *      每条规则都必须满足"人类标注在这种情形下几乎不会有分歧"。
 *   2. 规则命中必须留下可核对的理由（命中了哪条、依据什么数字），
 *      否则评测报告里出现"系统判 A 赢"却没人知道为什么，比不判更糟。
 *   3. 不做语义判断。这里只回答形如"题目要一个标签，A 给了标签而 B 给了 277 字"
 *      这种可计数的问题。
 *
 * 目前只有两条规则，都是实测中错误最集中的两类题型。
 */

/** 去空白后的字符数：中英文混排下比 split(' ') 更接近人眼判断的"篇幅" */
export function charCount(text) {
  return String(text ?? '').replace(/\s+/g, '').length;
}

/**
 * 规则 1 · 枚举型标签题
 *
 * 题目里出现 `（正面/负面/中性）`、`（记叙/说明/议论）` 这类用斜杠分隔的候选集，
 * 说明期望的输出就是一个标签。若一方只给了短标签、另一方给了长篇解释，判短方赢。
 *
 * 阈值为什么是 20 / 100：实测数据里标签型答案都在 2-6 字，
 * 而长篇解释都在 170 字以上，中间留足安全区。20 字以内仍算"标签"，
 * 100 字以上才算"长篇"，避免把"标签 + 一句理由"误判成违规。
 */
function ruleLabel({ prompt, answer_A, answer_B }) {
  // 半角/全角括号内的斜杠枚举，至少两个候选
  const m = String(prompt).match(/[（(]([^（）()]{2,40}?\/[^（）()]{2,40}?)[）)]/);
  if (!m) return null;

  // 安全阀：题目要求"选一个并说明理由"时，长回答是**被要求的**，
  // 此时按长度判短方赢就是误判。宁可漏判交给模型。
  if (/(说明理由|说明原因|并说明|并解释|并给出理由|并简要说明|理由)/.test(String(prompt))) {
    return null;
  }

  const candidates = m[1].split('/').map((s) => s.trim()).filter(Boolean);
  if (candidates.length < 2) return null;

  const lenA = charCount(answer_A);
  const lenB = charCount(answer_B);
  const SHORT = 20;
  const LONG = 100;

  const aIsLabel = lenA <= SHORT;
  const bIsLabel = lenB <= SHORT;

  if (aIsLabel && lenB >= LONG) {
    return {
      choice: 'A',
      rule: 'label_enum',
      detail: `题目限定从「${candidates.join('/')}」中选一个；A 为 ${lenA} 字标签，B 为 ${lenB} 字长解释`,
    };
  }
  if (bIsLabel && lenA >= LONG) {
    return {
      choice: 'B',
      rule: 'label_enum',
      detail: `题目限定从「${candidates.join('/')}」中选一个；B 为 ${lenB} 字标签，A 为 ${lenA} 字长解释`,
    };
  }
  return null;
}

/**
 * 规则 2 · 明确字数上限
 *
 * 题目写了「不超过 N 字」「N 字以内」「限 N 字」，就按这个上限硬判：
 * 一方超、另一方不超 → 判不超的赢。都超或都不超 → 不判定，交给模型。
 *
 * 「一句话/N 句话」不做规则化：中文分句边界太模糊，
 * "一句话"用逗号连起来算不算一句，正则会判错（S01 就是这种）。
 */
function ruleWordLimit({ prompt, answer_A, answer_B }) {
  const p = String(prompt);
  const patterns = [
    /不超过\s*(\d+)\s*字/,
    /(\d+)\s*字以内/,
    /限\s*(\d+)\s*字/,
    /不得超过\s*(\d+)\s*字/,
  ];
  let limit = null;
  for (const re of patterns) {
    const m = p.match(re);
    if (m) {
      limit = Number(m[1]);
      break;
    }
  }
  if (!limit || !Number.isFinite(limit)) return null;

  const lenA = charCount(answer_A);
  const lenB = charCount(answer_B);
  const aOk = lenA <= limit;
  const bOk = lenB <= limit;

  if (aOk && !bOk) {
    return {
      choice: 'A',
      rule: 'word_limit',
      detail: `题目限 ${limit} 字；A ${lenA} 字合规，B ${lenB} 字超限`,
    };
  }
  if (bOk && !aOk) {
    return {
      choice: 'B',
      rule: 'word_limit',
      detail: `题目限 ${limit} 字；B ${lenB} 字合规，A ${lenA} 字超限`,
    };
  }
  return null;
}

const RULES = [ruleLabel, ruleWordLimit];

/**
 * 尝试用规则直接判出胜负。
 * @returns {{choice:'A'|'B', rule:string, detail:string} | null} null 表示交回模型
 */
export function decideByRule(input) {
  for (const fn of RULES) {
    const hit = fn(input);
    if (hit) return hit;
  }
  return null;
}

export const RULE_NAMES = RULES.map((f) => f.name.replace(/^rule/, '').toLowerCase());

// ───────────────────────── 平手兜底：只差一层无信息包装 ─────────────────────────

/**
 * 平手复核规则（LLM 判完之后的兜底，不参与前置短路）
 *
 * 实测来源：留出集 36 条里 Judge 的 4 条分歧**全是它判平手**。逐条看下来是同一个模式——
 * 生成器造的「好答案变体」只是在原答案外面套了一层无信息包装：
 *
 *   A: 是，由传递性可推出            B: 简明地说：是，由传递性可推出。
 *   A: 简明地说：正面。              B: 正面
 *   A: 便利店营业到很晚……            B: 一般认为是「便利店营业到很晚……」。
 *
 * 人在这 4 条上都毫不犹豫地选了「没包装的那一方」。理由很直接：包装不含信息，
 * 「简明地说」后面接一整句原话本身就自相矛盾，「一般认为是」把陈述降级成传闻。
 * 这不是审美偏好，是可机检的结构差异：**去掉包装后与对方逐字相同**。
 *
 * 边界（刻意保守）：
 *   - 只认白名单里的无信息前缀，不做「任意 xx：」的通用匹配——
 *     「错：北京」这种前缀承载了语义，去掉就改变了答案，绝不能当包装。
 *   - 只在 LLM 已判平手时调用，不参与前置判优（否则会抢掉规则的活）。
 *   - 去掉包装后必须与对方**逐字相同**，不做相似度阈值，避免误伤改写型答案。
 */
const FREE_PREFIX = [
  '简明地说', '简单地讲', '简单地说', '简单来说', '简而言之', '简言之',
  '总的来说', '一句话说', '一句话概括', '答', '答案是', '回答是', '直接说', '说白了',
  '结论是', '总结一下',
];
const HEDGE_PREFIX = ['一般认为是', '普遍认为', '通常认为', '有人认为', '一般认为'];

/** 去掉空白与首尾的引号/括号/标点，只留内容本身 */
export function stripDecoration(text) {
  const lead = /^[「『“"'（(【\[]+/;
  const tail = /[」』”"'）)】\]。．.！!？?，,；;：:]+$/;
  return String(text ?? '').replace(/\s+/g, '').replace(lead, '').replace(tail, '');
}

function unwrapPrefix(t) {
  for (const w of FREE_PREFIX) {
    if (t.startsWith(w)) {
      return t.slice(w.length).replace(/^[：:，,、\s]+/, '');
    }
  }
  return null;
}

function unwrapHedge(t) {
  for (const w of HEDGE_PREFIX) {
    if (t.startsWith(w)) {
      return t.slice(w.length).replace(/^[：:，,\s]+/, '');
    }
  }
  return null;
}

/**
 * LLM 判平手后再看一眼：是不是「一方 = 另一方 + 无信息包装」。
 * @returns {{choice:'A'|'B', rule:string, detail:string} | null} null 表示维持平手
 */
export function resolveTie({ answer_A, answer_B }) {
  const a = stripDecoration(answer_A);
  const b = stripDecoration(answer_B);
  if (!a || !b || a === b) return null; // 完全相同由上游的 identical 守卫处理

  const sides = [
    { side: 'A', text: a, other: b },
    { side: 'B', text: b, other: a },
  ];
  for (const s of sides) {
    for (const unwrap of [unwrapPrefix, unwrapHedge]) {
      const inner = unwrap(s.text);
      if (inner === null) continue;
      if (stripDecoration(inner) === s.other) {
        return {
          choice: s.side === 'A' ? 'B' : 'A',
          rule: 'wrap_only',
          detail: `${s.side} 只是在对方内容外裹了一层无信息包装（去掉后与对方逐字相同），包装不加分`,
        };
      }
    }
  }
  return null;
}
