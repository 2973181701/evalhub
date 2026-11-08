/**
 * EvalHub · 异步评测队列
 *
 * 为什么要有：原来的 /api/eval/batch 是「一个 HTTP 请求跑完 20 条」，
 * 请求方只能干等，超时就丢结果，也没法看进度、没法取消、没法复查。
 * 企业里评测平台和脚本的区别就在这三点上。
 *
 * 设计：
 *   - 一次评测 = 一行 eval_runs（状态机 queued → running → succeeded/failed/canceled）
 *   - 每条结果 = 一行 eval_results（scores 存 jsonb，保留原始输出便于复查）
 *   - 进程内工作池，并发由 EVAL_CONCURRENCY 控制（默认 1，GLM 免费额度怕限流）
 *   - provider=local 时不调网络，直接对数据集里已存回答复算，用于回归与冒烟
 *   - 进程重启时把遗留的 running 标为 failed（不假装成功，也不无限 pending）
 *
 * JSON 模式：没有数据库时全部走内存，进程退出即丢，仅用于本地开发。
 */

import crypto from 'node:crypto';
import { score } from '../engine.js';
import { chat, glmReady, glmConfig } from '../glm.js';
import { pgEnabled, query, withTransaction } from '../db.js';

const CONCURRENCY = Math.max(1, Number(process.env.EVAL_CONCURRENCY || 1));
const ITEM_INTERVAL_MS = Number(process.env.EVAL_ITEM_INTERVAL_MS || 0);

/** 内存实现：JSON 模式或无库环境下使用 */
const mem = {
  runs: new Map(),
  results: new Map(), // runId → [{item_key, scores, total, ...}]
};

let repoRef = null;
let sequence = 0;

export function attachRepo(repo) {
  repoRef = repo;
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export function configHash(provider, model, config) {
  return crypto
    .createHash('sha256')
    .update(canonical({ provider, model, config }), 'utf8')
    .digest('hex');
}

const nowIso = () => new Date().toISOString();

// ─────────────────────────── 创建任务 ───────────────────────────

export async function createRun({ provider = 'local', model, ids, config = {}, actor = null }) {
  if (!['local', 'glm'].includes(provider)) {
    throw Object.assign(new Error(`不支持的 provider：${provider}（可选 local / glm）`), { status: 400 });
  }
  if (provider === 'glm' && !glmReady) {
    throw Object.assign(
      new Error('未配置 GLM api_key，无法创建 glm 评测任务；可改用 provider=local 复算基线'),
      { status: 503 },
    );
  }

  const snapshot = repoRef.snapshot();
  const picked = Array.isArray(ids) && ids.length
    ? snapshot.prompts.filter((p) => ids.includes(p.id))
    : snapshot.prompts;
  if (!picked.length) {
    throw Object.assign(new Error('没有匹配的题目，检查 ids'), { status: 400 });
  }

  const effModel = model || (provider === 'glm' ? glmConfig.model : 'engine-local');
  const hash = configHash(provider, effModel, config);
  const ref = repoRef.datasetRef();

  if (!pgEnabled()) {
    const id = `mem-${++sequence}-${Date.now().toString(36)}`;
    mem.runs.set(id, {
      id,
      dataset_id: ref.id,
      dataset_version: ref.version,
      provider,
      model: effModel,
      config,
      config_hash: hash,
      status: 'queued',
      total_items: picked.length,
      done_items: 0,
      failed_items: 0,
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      error: null,
      canceled: false,
      items: picked,
    });
    mem.results.set(id, []);
    enqueue(id);
    return { id, status: 'queued', total_items: picked.length, storage: 'memory' };
  }

  const actorId = actor?.sub && /^\d+$/.test(String(actor.sub)) ? Number(actor.sub) : null;

  const { rows } = await query(
    `INSERT INTO eval_runs (dataset_id, provider, model, config, config_hash, status, total_items, item_keys, created_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, 'queued', $6, $7, $8)
     RETURNING id, status, total_items, created_at`,
    [ref.id, provider, effModel, JSON.stringify(config), hash, picked.length, picked.map((p) => p.id), actorId],
  );

  await query(
    `INSERT INTO audit_logs (actor_id, action, target, detail)
     VALUES ($1, 'run.create', $2, $3::jsonb)`,
    [actorId, String(rows[0].id), JSON.stringify({ provider, model: effModel, items: picked.length })],
  );
  enqueue(rows[0].id);
  return { ...rows[0], storage: 'postgres' };
}

// ─────────────────────────── 查询 ───────────────────────────

export async function listRuns({ limit = 20 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 20, 1), 100);
  if (!pgEnabled()) {
    return [...mem.runs.values()]
      .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
      .slice(0, n)
      .map(publicRun);
  }
  const { rows } = await query(
    `SELECT id, dataset_id, provider, model, config_hash, status,
            total_items, done_items, failed_items, tokens_in, tokens_out, cost_usd,
            error, created_at, started_at, finished_at
       FROM eval_runs ORDER BY created_at DESC LIMIT $1`,
    [n],
  );
  return rows;
}

export async function getRun(id) {
  if (!pgEnabled()) {
    const r = mem.runs.get(id);
    return r ? publicRun(r) : null;
  }
  const { rows } = await query(
    `SELECT id, dataset_id, provider, model, config, config_hash, status,
            total_items, item_keys, done_items, failed_items, tokens_in, tokens_out, cost_usd,
            error, created_at, started_at, finished_at
       FROM eval_runs WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getResults(id) {
  if (!pgEnabled()) {
    if (!mem.runs.has(id)) return null;
    return mem.results.get(id) ?? [];
  }
  const { rows } = await query(
    `SELECT item_key, scores, total, output, latency_ms, tokens_in, tokens_out, cost_usd, error
       FROM eval_results WHERE run_id = $1 ORDER BY id`,
    [id],
  );
  return rows.map((r) => ({
    id: r.item_key,
    ...r.scores,
    total: r.total === null ? null : Number(r.total),
    output: r.output,
    latency_ms: r.latency_ms,
    error: r.error,
  }));
}

export async function cancelRun(id) {
  if (!pgEnabled()) {
    const r = mem.runs.get(id);
    if (!r) return null;
    if (['succeeded', 'failed', 'canceled'].includes(r.status)) return publicRun(r);
    r.canceled = true;
    r.status = 'canceled';
    r.finished_at = nowIso();
    return publicRun(r);
  }
  const { rows } = await query(
    `UPDATE eval_runs
        SET status = 'canceled', finished_at = now()
      WHERE id = $1 AND status IN ('queued', 'running')
      RETURNING id, status, done_items, total_items`,
    [id],
  );
  return rows[0] ?? null;
}

function publicRun(r) {
  return {
    id: r.id,
    dataset_id: r.dataset_id,
    provider: r.provider,
    model: r.model,
    config_hash: r.config_hash,
    status: r.status,
    total_items: r.total_items,
    done_items: r.done_items,
    failed_items: r.failed_items,
    error: r.error,
    created_at: r.created_at,
    started_at: r.started_at,
    finished_at: r.finished_at,
  };
}

// ─────────────────────────── 工作池 ───────────────────────────

const queue = [];
let active = 0;
let pollTimer = null;
const POLL_MS = Math.max(200, Number(process.env.EVAL_POLL_MS || 500));

/**
 * 向数据库领取一个待跑任务。
 *
 * `FOR UPDATE SKIP LOCKED` 是关键：多个副本同时轮询时，
 * 同一行只会被一个事务拿到，其余直接跳过——不需要额外的分布式锁。
 * 没有它，两个实例会同时认领同一条 run，花两倍的钱跑同一批题。
 */
async function claimNext() {
  const { rows } = await query(
    `UPDATE eval_runs
        SET status = 'running', started_at = now()
      WHERE id = (
              SELECT id FROM eval_runs
               WHERE status = 'queued'
               ORDER BY created_at
               FOR UPDATE SKIP LOCKED
               LIMIT 1
            )
        AND status = 'queued'
      RETURNING id`,
  );
  return rows[0]?.id ?? null;
}

/** 多实例安全：不靠内存队列，靠数据库状态机；每次轮询尝试领满并发额度 */
async function tick() {
  if (!pgEnabled()) return;
  while (active < CONCURRENCY) {
    let id;
    try {
      id = await claimNext();
    } catch (e) {
      console.error('[EvalHub] 领取任务失败：', e.message);
      return;
    }
    if (!id) return;
    active += 1;
    runOne(id, { claimed: true })
      .catch((e) => console.error('[EvalHub] 评测任务异常：', e))
      .finally(() => {
        active -= 1;
        setImmediate(tick);
      });
  }
}

/** PostgreSQL 模式下启动轮询器（JSON 模式仍用内存队列） */
export function startWorker() {
  if (!pgEnabled() || pollTimer) return;
  pollTimer = setInterval(() => {
    tick().catch((e) => console.error('[EvalHub] 轮询异常：', e.message));
  }, POLL_MS);
  pollTimer.unref?.();
  tick().catch(() => {});
}

export function stopWorker() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function enqueue(id) {
  if (pgEnabled()) {
    // 库里已有 queued 行，轮询器会领走；这里只做一次即时触发以降低延迟
    setImmediate(() => tick().catch(() => {}));
    return;
  }
  queue.push(id);
  setImmediate(pump);
}

function pump() {
  while (active < CONCURRENCY && queue.length) {
    const id = queue.shift();
    active += 1;
    runOne(id)
      .catch((e) => console.error('[EvalHub] 评测任务异常：', e))
      .finally(() => {
        active -= 1;
        setImmediate(pump);
      });
  }
}

async function runOne(id, { claimed = false } = {}) {
  const isPg = pgEnabled();

  if (isPg && !claimed) {
    // 已被取消或别的实例领走的任务不再执行
    const { rows } = await query(
      `UPDATE eval_runs SET status = 'running', started_at = now()
        WHERE id = $1 AND status = 'queued' RETURNING total_items`,
      [id],
    );
    if (!rows.length) return;
  } else if (!isPg) {
    const r = mem.runs.get(id);
    if (!r || r.status !== 'queued') return;
    r.status = 'running';
    r.started_at = nowIso();
  }

  const snapshot = repoRef.snapshot();
  const run = isPg
    ? (await query(`SELECT provider, model, total_items, config, item_keys FROM eval_runs WHERE id=$1`, [id])).rows[0]
    : mem.runs.get(id);

  const provider = run.provider;
  // 选题必须按任务自己的 item_keys 执行：否则 total_items=3 却会跑完整数据集 20 条
  const items = isPg
    ? (run.item_keys && run.item_keys.length
        ? snapshot.prompts.filter((p) => run.item_keys.includes(p.id))
        : snapshot.prompts)
    : run.items;

  let done = 0;
  let failed = 0;

  for (const p of items) {
    // 每条开始前检查取消（PG 读库，内存读标志）
    if (isPg) {
      const { rows } = await query(`SELECT status FROM eval_runs WHERE id = $1`, [id]);
      if (!rows.length || rows[0].status === 'canceled') return;
    } else {
      const r = mem.runs.get(id);
      if (!r || r.canceled) return;
    }

    const t0 = Date.now();
    let row;
    try {
      // config.temperature 透传给模型：同模型不同参数的对比全靠它，
      // 否则两次 glm 任务的 config_hash 一样，却解释不了分数差异从哪来
      const temperature = run.config?.temperature;
      const answer = provider === 'glm'
        ? await chat(p.prompt, temperature != null ? { temperature: Number(temperature) } : {})
        : (snapshot.byId.answer.get(p.id)?.answer ?? '');
      const s = score({
        prompt: p.prompt,
        answer,
        reference: p.reference ?? '',
        task_type: p.task_type,
      });
      row = {
        item_key: p.id,
        scores: s,
        total: s.total ?? null,
        output: answer,
        latency_ms: Date.now() - t0,
        tokens_in: null,
        tokens_out: null,
        cost_usd: 0,
        error: s.error ? String(s.error) : null,
      };
      if (s.error) failed += 1;
      else done += 1;
    } catch (e) {
      failed += 1;
      row = {
        item_key: p.id,
        scores: {},
        total: null,
        output: null,
        latency_ms: Date.now() - t0,
        tokens_in: null,
        tokens_out: null,
        cost_usd: 0,
        error: e.message,
      };
    }

    if (isPg) {
      await withTransaction(async (c) => {
        await c.query(
          `INSERT INTO eval_results (run_id, item_key, scores, total, output, latency_ms, tokens_in, tokens_out, cost_usd, error)
           VALUES ($1,$2,$3::jsonb,$4,$5,$6,$7,$8,$9,$10)
           ON CONFLICT (run_id, item_key) DO NOTHING`,
          [
            id, row.item_key, JSON.stringify(row.scores), row.total, row.output,
            row.latency_ms, row.tokens_in, row.tokens_out, row.cost_usd, row.error,
          ],
        );
        await c.query(
          `UPDATE eval_runs SET done_items = done_items + $2, failed_items = failed_items + $3 WHERE id = $1`,
          [id, row.error ? 0 : 1, row.error ? 1 : 0],
        );
      });
    } else {
      mem.results.get(id).push({ id: row.item_key, ...row.scores, total: row.total, output: row.output, latency_ms: row.latency_ms, error: row.error });
      const r = mem.runs.get(id);
      r.done_items = done;
      r.failed_items = failed;
    }

    if (ITEM_INTERVAL_MS) await new Promise((r) => setTimeout(r, ITEM_INTERVAL_MS));
  }

  if (isPg) {
    await query(
      `UPDATE eval_runs
          SET status = CASE WHEN failed_items >= total_items AND total_items > 0 THEN 'failed' ELSE 'succeeded' END,
              finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [id],
    );
  } else {
    const r = mem.runs.get(id);
    if (r && r.status === 'running') {
      r.status = failed >= r.total_items ? 'failed' : 'succeeded';
      r.finished_at = nowIso();
    }
  }
}

// ─────────────────────────── 启动恢复 ───────────────────────────

/**
 * 进程重启后，上一轮遗留的 running 任务不会有人接着跑。
 * 直接标 failed 并写清原因——比留在 running 假装在跑要诚实。
 */
export async function recoverStaleRuns() {
  if (!pgEnabled()) return { recovered: 0 };
  const { rowCount } = await query(
    `UPDATE eval_runs
        SET status = 'failed',
            error = COALESCE(error, '进程重启，任务中断（未完成的 run 不会自动续跑）'),
            finished_at = now()
      WHERE status = 'running'`,
  );
  const { rowCount: requeued } = await query(
    `UPDATE eval_runs SET status = 'queued' WHERE status = 'queued' AND started_at IS NULL`,
  );
  return { recovered: rowCount, queued: requeued };
}

export function queueStats() {
  return { concurrency: CONCURRENCY, active, pending: queue.length };
}
