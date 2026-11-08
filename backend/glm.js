/**
 * EvalHub · GLM 大模型客户端（OpenAI 兼容接口）
 *
 * 密钥安全（红线）：
 *   - api_key 只从本地 `llm-eval-project/config.json` 或环境变量 GLM_API_KEY 读取
 *   - 绝不写进代码、绝不写进 README、绝不写进 Git、绝不出现在任何 HTTP 响应里
 *   - 日志只打印「密钥已加载（长度 N）」这类元信息
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** 用户已有项目的配置位置（相对 evalhub/ 的上一级） */
const CONFIG_CANDIDATES = [
  path.resolve(HERE, '..', '..', 'llm-eval-project', 'config.json'),
  path.resolve(HERE, '..', 'config.json'),
];

function readConfig() {
  for (const p of CONFIG_CANDIDATES) {
    if (fs.existsSync(p)) {
      try {
        return JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch {
        /* 配置损坏时继续找下一个 */
      }
    }
  }
  return {};
}

const cfg = readConfig();

export const glmConfig = {
  apiKey: process.env.GLM_API_KEY || cfg.api_key || '',
  baseUrl: process.env.GLM_BASE_URL || cfg.base_url || 'https://open.bigmodel.cn/api/paas/v4',
  model: process.env.GLM_MODEL || cfg.model || 'glm-4-flash',
  systemRole: cfg.system_role || '你是一个智能助手',
};

/** 是否具备真实调用大模型的条件（前端据此决定是否禁用「调模型」按钮） */
export const glmReady = Boolean(glmConfig.apiKey);

/** 密钥是否就绪只暴露布尔值，永不暴露密钥本身 */
export function glmStatus() {
  return {
    ready: glmReady,
    base_url: glmConfig.baseUrl,
    model: glmConfig.model,
    key_source: process.env.GLM_API_KEY ? 'env:GLM_API_KEY' : glmReady ? 'llm-eval-project/config.json' : '未找到',
  };
}

/**
 * 极简请求节流队列：串行 + 最小间隔，避免撞上智谱的限流。
 * 参考用户已有的 eval.py（那里用的是 time.sleep(1)）。
 */
const MIN_INTERVAL_MS = Number(process.env.GLM_MIN_INTERVAL_MS || 1200);
let chain = Promise.resolve();
let lastAt = 0;

function schedule(task) {
  const run = chain.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      return await task();
    } finally {
      lastAt = Date.now();
    }
  });
  // 单次失败不阻断队列
  chain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * 调用 GLM 生成回答。
 * @param {string} prompt 用户问题
 * @param {{temperature?:number, maxTokens?:number}} [opts]
 * @returns {Promise<string>} 模型回答文本
 */
export function chat(prompt, opts = {}) {
  if (!glmReady) {
    throw new Error('未配置 GLM api_key，无法调用大模型（请在 llm-eval-project/config.json 中填写）');
  }
  const maxAttempts = Math.max(1, Number(process.env.GLM_MAX_ATTEMPTS || 3));

  /**
   * 只重试「值得重试」的失败：5xx / 429 / 网络抖动。
   * 4xx（密钥错、参数错）重试只会浪费额度并把问题掩盖成超时，
   * 必须立刻抛出，让调用方看到真实原因。
   */
  const retryable = (status, err) => {
    if (err) return true; // fetch 抛错 = 网络层问题
    return status >= 500 || status === 429;
  };

  return schedule(async () => {
    let lastErr;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      let res;
      try {
        res = await fetch(`${glmConfig.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${glmConfig.apiKey}`,
          },
          body: JSON.stringify({
            model: glmConfig.model,
            messages: [
              // 允许单次调用覆盖 system 提示：Judge 需要独立的评分 rubric，
              // 不能复用对话用的「你是一个智能助手」
              { role: 'system', content: opts.systemRole || glmConfig.systemRole },
              { role: 'user', content: prompt },
            ],
            temperature: opts.temperature ?? 0.7,
            ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
          }),
        });
      } catch (e) {
        lastErr = new Error(`GLM 网络错误：${e.message}`);
        if (attempt < maxAttempts) {
          await new Promise((r) => setTimeout(r, 800 * attempt));
          continue;
        }
        throw lastErr;
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        lastErr = new Error(`GLM 调用失败 HTTP ${res.status}：${text.slice(0, 200)}`);
        if (retryable(res.status) && attempt < maxAttempts) {
          // 指数退避：1.6s、3.2s……避免把限流打成雪崩
          await new Promise((r) => setTimeout(r, 800 * 2 ** (attempt - 1)));
          continue;
        }
        throw lastErr;
      }

      const data = await res.json();
      const answer = data?.choices?.[0]?.message?.content;
      if (typeof answer !== 'string') {
        throw new Error('GLM 返回结构异常，未取到 choices[0].message.content');
      }
      return answer;
    }
    throw lastErr ?? new Error('GLM 调用失败（未知原因）');
  });
}
