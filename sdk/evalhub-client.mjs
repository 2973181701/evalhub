/**
 * EvalHub 客户端 SDK（零依赖）
 *
 * 为什么单独抽出来：服务化的标志不是「有 HTTP 接口」，而是**别人能不读你的源码就用起来**。
 * 这个文件就是那个「别人拿到就能用」的东西——CI 脚本、训练平台、发布系统都直接 import 它。
 *
 * 两种身份：
 *   - apiKey：机器长期凭据（推荐 CI 用），绑定业务线与角色
 *   - token：人用的 JWT，8 小时过期
 *
 * 用法：
 *   import { EvalHubClient } from './sdk/evalhub-client.mjs';
 *   const c = new EvalHubClient({ baseUrl: 'http://127.0.0.1:3000', apiKey: process.env.EVALHUB_API_KEY });
 *   const run = await c.createRun({ provider: 'local', ids: ['K01','K02'] });
 *   const done = await c.waitRun(run.id);
 *   console.log(await c.aggregate(done.id));
 */

const DIMS = ['accuracy', 'completeness', 'logic', 'safety', 'expression'];

export class EvalHubError extends Error {
  constructor(message, { status = 0, path = '', body = null } = {}) {
    super(message);
    this.name = 'EvalHubError';
    this.status = status;
    this.path = path;
    this.body = body;
  }
}

export class EvalHubClient {
  constructor({ baseUrl = 'http://127.0.0.1:3000', apiKey = null, token = null, tenant = null, timeoutMs = 60_000 } = {}) {
    if (!apiKey && !token) throw new EvalHubError('需要 apiKey 或 token 之一');
    this.baseUrl = String(baseUrl).replace(/\/+$/, '');
    this.apiKey = apiKey;
    this.token = token;
    this.tenant = tenant;
    this.timeoutMs = timeoutMs;
  }

  headers() {
    const h = { 'Content-Type': 'application/json' };
    // API Key 与 JWT 都走 Bearer；服务端按前缀区分，客户端不需要知道细节
    h.Authorization = `Bearer ${this.apiKey || this.token}`;
    if (this.tenant) h['X-Tenant'] = this.tenant;
    return h;
  }

  async request(path, { method = 'GET', body } = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    let res;
    try {
      res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(),
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ac.signal,
      });
    } catch (e) {
      throw new EvalHubError(`请求失败：${e.message}（${method} ${path}）`, { path });
    } finally {
      clearTimeout(timer);
    }

    let payload = null;
    try {
      payload = await res.json();
    } catch {
      throw new EvalHubError(`后端返回非 JSON（HTTP ${res.status}）`, { status: res.status, path });
    }
    if (!res.ok || payload?.ok === false) {
      throw new EvalHubError(payload?.error || `HTTP ${res.status}`, {
        status: res.status, path, body: payload,
      });
    }
    return payload.data;
  }

  // ── 基础能力 ────────────────────────────────────────────────
  health() { return this.request('/api/health'); }

  createRun({ provider = 'local', model, ids, config = {} } = {}) {
    return this.request('/api/runs', { method: 'POST', body: { provider, model, ids, config } });
  }

  getRun(id) { return this.request(`/api/runs/${id}`); }

  /**
   * 逐条结果。服务端返回的是 { count, rows } 信封（带 count 便于分页扩展），
   * SDK 归一化成数组 —— 让调用方拿到就能 filter/map，不用每次拆信封。
   */
  async results(id) {
    const data = await this.request(`/api/runs/${id}/results`);
    return Array.isArray(data) ? data : (data?.rows ?? []);
  }

  cancelRun(id) { return this.request(`/api/runs/${id}/cancel`, { method: 'POST' }); }

  compare(a, b) { return this.request(`/api/runs/${a}/compare/${b}`); }

  rubrics() { return this.request('/api/rubrics'); }

  gate({ key, version = null, scores }) {
    return this.request('/api/rubrics/gate', { method: 'POST', body: { key, version, scores } });
  }

  // ── 组合能力 ────────────────────────────────────────────────

  /** 轮询到终态。只在 queued/running 时轮询，终态立即返回，避免无意义空转 */
  async waitRun(id, { timeoutMs = 10 * 60_000, intervalMs = 1000, onProgress = null } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await this.getRun(id);
      if (onProgress) onProgress(run);
      if (['succeeded', 'failed', 'canceled'].includes(run.status)) return run;
      if (Date.now() > deadline) {
        throw new EvalHubError(`等待任务超时（${timeoutMs}ms）：${id}，状态仍为 ${run.status}`, { path: `/api/runs/${id}` });
      }
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * 汇总五维均值。
   * 只统计「有分数」的行：失败的条目 total 为 null，把它当 0 会把结果稀释成假的低分。
   */
  async aggregate(id) {
    const rows = await this.results(id);
    const ok = rows.filter((r) => r.total !== null && r.total !== undefined);
    if (!ok.length) return { n: 0, total: null, dims: Object.fromEntries(DIMS.map((d) => [d, null])), failed: rows.length };
    const mean = (pick) => Number((ok.reduce((s, r) => s + (Number(pick(r)) || 0), 0) / ok.length).toFixed(3));
    return {
      n: ok.length,
      failed: rows.length - ok.length,
      total: mean((r) => r.total),
      dims: Object.fromEntries(DIMS.map((d) => [d, mean((r) => r[d])])),
    };
  }

  /** 一步到位：跑一次评测并返回汇总（CI 里最常用） */
  async runAndAggregate({ provider = 'local', ids, config = {}, timeoutMs, onProgress } = {}) {
    const run = await this.createRun({ provider, ids, config });
    const done = await this.waitRun(run.id, { timeoutMs, onProgress });
    const agg = await this.aggregate(run.id);
    return { run: done, aggregate: agg };
  }
}

export { DIMS };
