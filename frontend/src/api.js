/**
 * 后端接口封装。
 * 所有请求都走相对路径 /api/*，由 Vite 代理转发到 http://127.0.0.1:3000。
 */

async function request(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let body;
  try {
    body = await res.json();
  } catch {
    throw new Error(`后端返回了非 JSON 内容（HTTP ${res.status}）`);
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
};
