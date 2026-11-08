/**
 * 后端接口封装。
 * 所有请求都走相对路径 /api/*，由 Vite 代理转发到 http://127.0.0.1:3000。
 *
 * 令牌：存 localStorage，请求自动带 Authorization。
 * 遇到 401 会清掉本地令牌并广播 `evalhub:unauthorized`，由 App 切到登录页——
 * 避免「令牌过期后每个按钮都报错」这种最难解释的体验。
 */

const TOKEN_KEY = 'evalhub.token';

export function getToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* 隐私模式下 localStorage 可能不可写，忽略即可 */
  }
}

async function request(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(path, { ...options, headers });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`后端返回了非 JSON 内容（HTTP ${res.status}）`);
  }
  if (res.status === 401 && token) {
    setToken('');
    window.dispatchEvent(new CustomEvent('evalhub:unauthorized'));
  }
  if (!res.ok || body.ok === false) {
    const err = new Error(body.error || `请求失败（HTTP ${res.status}）`);
    err.payload = body;
    err.status = res.status;
    throw err;
  }
  return body.data;
}

const post = (path, data) => request(path, { method: 'POST', body: JSON.stringify(data ?? {}) });
const get = (path) => request(path);

export const api = {
  health: () => get('/api/health'),
  prompts: () => get('/api/prompts'),
  dataset: () => get('/api/dataset'),
  score: (payload) => post('/api/score', payload),
  evalOne: (payload) => post('/api/eval', payload),
  annotate: (payload) => post('/api/annotate', payload),
  checkAnnotation: (payload) => post('/api/annotate/check', payload),
  report: () => get('/api/report'),
  consistency: () => get('/api/consistency'),
  scores: () => get('/api/scores'),
  exportRlhf: (format) => post('/api/export', { format }),

  // 认证
  authStatus: () => get('/api/auth/status'),
  login: (email, password) => post('/api/auth/login', { email, password }),
  me: () => get('/api/auth/me'),

  // 评测任务
  createRun: (payload) => post('/api/runs', payload),
  listRuns: (limit = 20) => get(`/api/runs?limit=${limit}`),
  getRun: (id) => get(`/api/runs/${id}`),
  runResults: (id) => get(`/api/runs/${id}/results`),
  cancelRun: (id) => post(`/api/runs/${id}/cancel`),
  compareRuns: (a, b) => get(`/api/runs/${a}/compare/${b}`),

  // LLM-as-Judge
  judgeStatus: () => get('/api/judge/status'),
  judgeScore: (payload) => post('/api/judge/score', payload),
  judgePreferences: (limit) => post('/api/judge/preferences', limit ? { limit } : {}),

  // 标注队列（盲标）
  labelQueue: (opts = {}) => {
    const q = new URLSearchParams({ limit: String(opts.limit || 20) });
    if (opts.all) q.set('all', '1');
    if (opts.taskType) q.set('task_type', opts.taskType);
    return get(`/api/label-queue?${q}`);
  },
  labelQueueStats: () => get('/api/label-queue/stats'),
  submitLabel: (id, payload) => post(`/api/label-queue/${id}/label`, payload),
};
