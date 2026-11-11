/**
 * EvalHub · Node 网关（HTTP 服务）
 *
 * 三层架构里的中间层，只做三件事：
 *   1. 调 GLM API 生成回答（唯一需要网络的环节）
 *   2. 把文本丢给 MoonBit 核心引擎做纯计算（打分 / 校验 / 统计 / 导出）
 *   3. 把结果用 HTTP 暴露给 Vue 前端
 *
 * 启动： node server.js        （默认 http://127.0.0.1:3000）
 * 环境变量： PORT / HOST / GLM_API_KEY / GLM_BASE_URL / GLM_MODEL / GLM_MIN_INTERVAL_MS
 *
 * ⚠ 默认只监听 127.0.0.1：后端不直接对公网暴露，统一走 nginx 反代。
 *   容器/局域网调试需要对外时显式设 HOST=0.0.0.0，不要改默认值。
 */

// 必须第一个导入：store.js 在模块加载时就会读 DATABASE_URL，
// 晚一步加载 .env 就会连不上库（pm2 场景下尤其容易踩）
import './env.js';
import express from 'express';
import cors from 'cors';
import { engineVersion, ENGINE_BUILD, score, validateAnnotation, consistency } from './engine.js';
import { glmStatus, chat, glmReady, glmConfig } from './glm.js';
import {
  load,
  annotations,
  submitAnnotation,
  fullReport,
  consistencyReport,
  rlhfExport,
  scoresOfRealAnswers,
  ruleJudge,
  storageInfo,
  repoRef,
} from './store.js';
import {
  attachRepo,
  createRun,
  listRuns,
  getRun,
  getResults,
  cancelRun,
  recoverStaleRuns,
  queueStats,
  startWorker,
} from './jobs/runs.js';
import { authEnabled, authStatus, requireRole, signToken } from './auth.js';
import { login, listUsers, createUser, getUserById } from './users.js';
import { compareRuns } from './compare.js';
import { scoreAnswer, preferPair, judgeReady, cacheStats, DIMS, DIM_CN } from './judge.js';
import { listQueue, getPair, submitLabel, stats as labelStats, LabelingError } from './labeling/queue.js';
import {
  list as listRubrics,
  get as getRubric,
  register as registerRubric,
  gate as runGate,
  activate as activateRubric,
  RubricError,
} from './rubrics/registry.js';
import {
  rebuild as rebuildLineage,
  graph as lineageGraph,
  walk as lineageWalk,
  seedEvents,
} from './governance/lineage.js';
import {
  seedRules,
  listRules,
  runChecks,
  latestReport,
  history as dqHistory,
  DqError,
} from './governance/quality.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
// 默认只听本机：公网入口只留 nginx，避免后端端口被直接访问
const HOST = process.env.HOST || '127.0.0.1';

app.use(cors());
app.use(express.json({ limit: '8mb' }));

/** 统一响应壳：成功 {ok:true,data}，失败 {ok:false,error} */
const ok = (res, data) => res.json({ ok: true, data });
const fail = (res, code, error) => res.status(code).json({ ok: false, error });

// ─────────────────────────────── 健康检查 ───────────────────────────────

app.get('/api/health', (_req, res) => {
  ok(res, {
    service: 'EvalHub backend',
    engine_version: engineVersion(),
    engine_build: ENGINE_BUILD,
    storage: storageInfo(),
    auth: authStatus(),
    queue: queueStats(),
    glm: glmStatus(),
    node: process.version,
    time: new Date().toISOString(),
  });
});

// ─────────────────────────────── 数据集 ───────────────────────────────

/** 题目 + A/B 偏好对 + 当前标注状态（标注界面用） */
app.get('/api/dataset', (_req, res) => {
  const { prompts, pairs } = load();
  const ann = new Map(annotations().map((a) => [a.id, a]));
  const items = pairs.map((p) => ({
    id: p.id,
    task_type: p.task_type,
    prompt: p.prompt,
    reference: p.reference ?? '',
    answer_A: p.answer_A,
    answer_B: p.answer_B,
    strategy_A_label: p.strategy_A_label ?? 'A',
    strategy_B_label: p.strategy_B_label ?? 'B',
    annotation: ann.get(p.id) ?? null,
  }));
  ok(res, {
    count: items.length,
    prompts_count: prompts.length,
    annotated_count: ann.size,
    items,
  });
});

/** 评测题目列表（评测看板用） */
app.get('/api/prompts', (_req, res) => {
  const { prompts, byId } = load();
  ok(
    res,
    prompts.map((p) => ({
      id: p.id,
      task_type: p.task_type,
      prompt: p.prompt,
      reference: p.reference ?? '',
      stored_answer: byId.answer.get(p.id)?.answer ?? null,
    })),
  );
});

// ─────────────────────────────── 评测 ───────────────────────────────

/** 只打分，不调模型：给一段现成的回答打五维分 */
app.post('/api/score', (req, res) => {
  const { prompt = '', answer = '', reference = '', task_type = '' } = req.body ?? {};
  const result = score({ prompt, answer, reference, task_type });
  if (result.error) return fail(res, 400, `引擎拒绝该输入：${result.error}`);
  ok(res, result);
});

/** 调 GLM 生成回答 + 引擎打分（评测看板的「真实跑一次」） */
app.post('/api/eval', async (req, res) => {
  const { prompt = '', reference = '', task_type = '', temperature } = req.body ?? {};
  if (!prompt.trim()) return fail(res, 400, 'prompt 不能为空');
  if (!glmReady) return fail(res, 503, '未配置 GLM api_key，无法调用大模型。可改用 POST /api/score 直接给现成回答打分。');
  try {
    const t0 = Date.now();
    const answer = await chat(prompt, { temperature });
    const result = score({ prompt, answer, reference, task_type });
    ok(res, {
      model: glmConfig.model,
      elapsed_ms: Date.now() - t0,
      answer,
      score: result,
    });
  } catch (e) {
    fail(res, 502, e.message);
  }
});

/**
 * 批量评测：对选中的题目逐条调 GLM + 打分。
 * 串行 + 最小间隔（在 glm.js 里节流），避免限流。
 */
app.post('/api/eval/batch', async (req, res) => {
  const { ids } = req.body ?? {};
  if (!glmReady) return fail(res, 503, '未配置 GLM api_key，无法批量调用大模型');
  const { prompts } = load();
  const picked = Array.isArray(ids) && ids.length ? prompts.filter((p) => ids.includes(p.id)) : prompts;
  const rows = [];
  for (const p of picked) {
    try {
      const answer = await chat(p.prompt);
      const s = score({ prompt: p.prompt, answer, reference: p.reference ?? '', task_type: p.task_type });
      rows.push({ id: p.id, task_type: p.task_type, prompt: p.prompt, answer, score: s, ok: true });
    } catch (e) {
      rows.push({ id: p.id, task_type: p.task_type, prompt: p.prompt, ok: false, error: e.message });
    }
  }
  const good = rows.filter((r) => r.ok).map((r) => ({ id: r.id, task_type: r.task_type, ...r.score }));
  ok(res, { count: rows.length, succeeded: good.length, rows, summary: good.length ? undefined : null });
});

// ─────────────────────────────── 标注 ───────────────────────────────

/** 提交一条 A/B 偏好标注：先过 MoonBit 标注引擎校验，通过才入库 */
app.post('/api/annotate', requireRole('evaluator'), async (req, res) => {
  const payload = req.body ?? {};
  if (!payload.id) return fail(res, 400, '缺少 id');
  try {
    const result = await submitAnnotation(payload);
    if (!result.accepted) {
      return res.status(422).json({ ok: false, error: '标注未通过校验', check: result.check });
    }
    ok(res, {
      check: result.check,
      record: result.record,
      annotated_count: annotations().length,
    });
  } catch (e) {
    fail(res, 500, `标注入库失败：${e.message}`);
  }
});

/** 只校验不落库（前端实时提示用） */
app.post('/api/annotate/check', (req, res) => {
  const { id = '', answer_A = '', answer_B = '', choice, reason = '', confidence } = req.body ?? {};
  const pair = load().byId.pair.get(id) ?? {};
  ok(res, validateAnnotation({
    id,
    answer_A: answer_A || pair.answer_A || '',
    answer_B: answer_B || pair.answer_B || '',
    choice,
    reason,
    confidence,
  }));
});

// ─────────────────────────────── 报告与导出 ───────────────────────────────

/** 汇总报告：数据集规模 / 五维统计 / 雷达图 / 一致性 / 标注质量 */
app.get('/api/report', (_req, res) => {
  ok(res, fullReport());
});

/** 一致性单查（人工 vs 规则判优） */
app.get('/api/consistency', (_req, res) => {
  ok(res, { consistency: consistencyReport(), rule_judge: ruleJudge() });
});

/** 真实回答的五维打分明细 */
app.get('/api/scores', (_req, res) => {
  ok(res, scoresOfRealAnswers());
});

/** 导出 RLHF 训练集：POST { format: "dpo" | "openai" } */
app.post('/api/export', requireRole('viewer'), (req, res) => {
  const format = req.body?.format === 'openai' ? 'openai' : 'dpo';
  const result = rlhfExport(format);
  const download = req.body?.download === true;
  if (download) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="evalhub_rlhf_${format}.json"`);
    return res.send(JSON.stringify(result, null, 2));
  }
  ok(res, result);
});

// ─────────────────────────────── 认证 ───────────────────────────────

/** 登录换令牌。口令校验失败与用户不存在返回同一错误，避免账号枚举。 */
app.post('/api/auth/login', async (req, res) => {
  const { email, password } = req.body ?? {};
  if (!email || !password) return fail(res, 400, 'email 与 password 必填');
  try {
    const user = await login(email, password);
    const t = signToken(user);
    ok(res, {
      token: t.token,
      token_type: 'Bearer',
      expires_in: t.expires_in,
      user: { id: user.id, email: user.email, role: user.role, display_name: user.display_name },
    });
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

/** 当前令牌身份（前端用来判断该显示哪些按钮） */
app.get('/api/auth/me', requireRole('viewer'), async (req, res) => {
  try {
    const u = await getUserById(req.user.sub);
    if (!u || !u.is_active) return fail(res, 401, '账号不存在或已停用');
    ok(res, u);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 鉴权是否开启——前端据此决定要不要显示登录框 */
app.get('/api/auth/status', (_req, res) => ok(res, authStatus()));

/** 用户管理（仅 admin） */
app.get('/api/users', requireRole('admin'), async (_req, res, next) => {
  try {
    ok(res, await listUsers());
  } catch (e) {
    next(e);
  }
});

app.post('/api/users', requireRole('admin'), async (req, res) => {
  try {
    ok(res, await createUser(req.body ?? {}));
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

// ─────────────────────────────── 评测任务（异步） ───────────────────────────────

/**
 * 创建评测任务。立即返回 run_id，不等跑完。
 * body: { provider?: 'local'|'glm', model?, ids?: string[], config?: object }
 */
app.post('/api/runs', requireRole('evaluator'), async (req, res) => {
  const { provider = 'local', model, ids, config } = req.body ?? {};
  try {
    const run = await createRun({ provider, model, ids, config, actor: req.user ?? null });
    ok(res, { ...run, poll: `/api/runs/${run.id}` });
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});

/** 任务列表（默认最近 20 条） */
app.get('/api/runs', async (req, res) => {
  try {
    ok(res, { queue: queueStats(), runs: await listRuns({ limit: req.query.limit }) });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 单个任务状态：进度看 done_items / total_items */
app.get('/api/runs/:id', async (req, res) => {
  try {
    const run = await getRun(req.params.id);
    if (!run) return fail(res, 404, `任务不存在：${req.params.id}`);
    ok(res, run);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 任务结果明细 */
app.get('/api/runs/:id/results', async (req, res) => {
  try {
    const rows = await getResults(req.params.id);
    if (rows === null) return fail(res, 404, `任务不存在：${req.params.id}`);
    ok(res, { count: rows.length, rows });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 取消任务：仅对 queued / running 生效 */
app.post('/api/runs/:id/cancel', requireRole('evaluator'), async (req, res) => {
  try {
    const run = await cancelRun(req.params.id);
    if (!run) return fail(res, 409, `任务不存在或已结束：${req.params.id}`);
    ok(res, run);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/**
 * 两次任务对比：GET /api/runs/:a/compare/:b
 * 差值方向固定为 B - A（正数 = B 更好），前端不再自己算方向。
 */
app.get('/api/runs/:a/compare/:b', async (req, res) => {
  try {
    ok(res, await compareRuns(req.params.a, req.params.b));
  } catch (e) {
    fail(res, e.status || 500, e.message);
  }
});


/** 两两 Cohen's κ：三方 Fleiss 会把弱评分者（规则判优）的噪声摊进来，看单独对齐度需要它 */
function cohenKappa(a, b) {
  const mapB = new Map(b.filter((x) => x.choice).map((x) => [x.id, x.choice]));
  const ids = a.filter((x) => x.choice && mapB.has(x.id));
  if (!ids.length) return { n: 0, po: 0, kappa: null };
  const cats = ['A', 'B', '平手'];
  const n = ids.length;
  let same = 0;
  for (const x of ids) if (mapB.get(x.id) === x.choice) same += 1;
  const po = same / n;
  let pe = 0;
  for (const c of cats) {
    const pa = ids.filter((x) => x.choice === c).length / n;
    const pb = ids.filter((x) => mapB.get(x.id) === c).length / n;
    pe += pa * pb;
  }
  const k = pe === 1 ? null : (po - pe) / (1 - pe);
  return { n, po: Number(po.toFixed(3)), kappa: k === null ? null : Number(k.toFixed(4)) };
}

// ─────────────────────────────── LLM-as-Judge ───────────────────────────────

app.get('/api/judge/status', (_req, res) => {
  ok(res, { ready: judgeReady(), cache: cacheStats(), dimensions: DIMS.map((d) => ({ key: d, label: DIM_CN[d] })) });
});

/**
 * 单条打分：给一段现成回答打五维分。
 * 加 evaluator 门禁是因为**每次调用都烧额度**，不能让匿名请求刷。
 */
app.post('/api/judge/score', requireRole('evaluator'), async (req, res) => {
  const { prompt = '', answer = '', reference = '', task_type = '' } = req.body ?? {};
  if (!prompt.trim() || !answer.trim()) return fail(res, 400, 'prompt 与 answer 必填');
  try {
    ok(res, await scoreAnswer({ prompt, answer, reference, task_type, useCache: req.body?.refresh !== true }));
  } catch (e) {
    fail(res, e.status || 502, e.message);
  }
});

/**
 * A/B 偏好判定（批量）：让 Judge 当第三个「标注者」。
 * 结果与人工标注、规则判优一起算一致性 —— 单看 Judge 分数没有意义，
 * 必须先证明它和人对得上。
 */
app.post('/api/judge/preferences', requireRole('evaluator'), async (req, res) => {
  if (!judgeReady()) return fail(res, 503, '未配置 GLM 密钥，Judge 不可用');
  const limit = Math.min(Number(req.body?.limit) || 20, 20);
  const pairs = load().pairs.slice(0, limit);
  const rows = [];
  for (const p of pairs) {
    try {
      const r = await preferPair({
        prompt: p.prompt,
        answer_A: p.answer_A,
        answer_B: p.answer_B,
        reference: p.reference ?? '',
        task_type: p.task_type,
        useCache: req.body?.refresh !== true,
      });
      rows.push({
        id: p.id, task_type: p.task_type, choice: r.choice, reason: r.reason,
        constraint: r.constraint, analysis: r.analysis, prompt_version: r.prompt_version, cached: r.cached,
      });
    } catch (e) {
      rows.push({ id: p.id, task_type: p.task_type, error: e.message });
    }
  }

  const judged = rows.filter((r) => !r.error);
  const human = annotations().filter((a) => r0(rows, a.id));
  function r0(list, id) {
    return list.some((x) => x.id === id && !x.error);
  }

  const records = [
    ...human.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
    ...judged.map((r) => ({ id: r.id, annotator: 'llm_judge', choice: r.choice })),
    ...ruleJudge().filter((r) => r0(rows, r.id)).map((r) => ({ id: r.id, annotator: 'rule_judge', choice: r.choice })),
  ];
  const threeWay = consistency({ records });

  // 两两一致率：分母只算「双方都有判定」的题，缺一方不算分歧
  const pairAgreement = (a, b) => {
    const mapB = new Map(b.filter((x) => x.choice).map((x) => [x.id, x.choice]));
    const list = a.filter((x) => mapB.has(x.id));
    const same = list.filter((x) => mapB.get(x.id) === x.choice).length;
    return { n: list.length, agree: same, rate: list.length ? Number(((same / list.length) * 100).toFixed(1)) : 0 };
  };

  ok(res, {
    count: rows.length,
    failed: rows.length - judged.length,
    rows,
    consistency_three_way: threeWay,
    kappa: {
      human_vs_judge: cohenKappa(annotations().map((a) => ({ id: a.id, choice: a.choice })), judged),
      human_vs_rule: cohenKappa(annotations().map((a) => ({ id: a.id, choice: a.choice })), ruleJudge()),
      rule_vs_judge: cohenKappa(ruleJudge(), judged),
    },
    agreement: {
      human_vs_judge: pairAgreement(
        annotations().map((a) => ({ id: a.id, choice: a.choice })),
        judged,
      ),
      human_vs_rule: pairAgreement(
        annotations().map((a) => ({ id: a.id, choice: a.choice })),
        ruleJudge(),
      ),
      rule_vs_judge: pairAgreement(ruleJudge(), judged),
    },
  });
});

// ─────────────────────────────── 标注队列（盲标 / 留出集） ───────────────────────────────

/**
 * 待标注列表。响应字段由仓储层白名单固定：
 * 不含 expected_choice（设计意图）、split（留出集分组）、strategy_*（会暴露设计意图）、reference。
 */
app.get('/api/label-queue', async (req, res) => {
  try {
    ok(res, {
      rows: await listQueue({
        limit: req.query.limit,
        offset: req.query.offset,
        onlyPending: req.query.all !== '1',
        taskType: req.query.task_type,
      }),
    });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get('/api/label-queue/stats', async (_req, res) => {
  try {
    ok(res, await labelStats());
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 标注是写操作且会形成金标准，必须 evaluator 及以上 */
app.post('/api/label-queue/:id/label', requireRole('evaluator'), async (req, res) => {
  const { choice, reason, confidence } = req.body ?? {};
  try {
    const record = await submitLabel({
      id: req.params.id,
      choice,
      reason,
      confidence,
      annotatorKey: req.user?.email ?? 'anonymous',
      // 不接客户端传的 label_source：标签来源只能由服务端决定，防止伪造金标准
      labelSource: 'human',
    });
    ok(res, { record, queue: await labelStats() });
  } catch (e) {
    if (e instanceof LabelingError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────── 指标注册中心（评测中台） ───────────────────────────────

/** 列出所有口径及其版本，前端可选任意版本做门禁 */
app.get('/api/rubrics', async (_req, res) => {
  try {
    ok(res, await listRubrics());
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get('/api/rubrics/:key', async (req, res) => {
  try {
    ok(res, await getRubric(req.params.key, req.query.version));
  } catch (e) {
    if (e instanceof RubricError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

/** 注册口径会改变全平台的判定标准，限 admin */
app.post('/api/rubrics', requireRole('admin'), async (req, res) => {
  try {
    const result = await registerRubric(req.body ?? {}, req.user?.email ?? null);
    ok(res, result);
  } catch (e) {
    if (e instanceof RubricError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

/**
 * 质量门禁：拿一批评测分数判定是否允许「上线」。
 * 无状态、不落库 —— 同一 rubric + 同一批分数永远得到同一结论，方便 CI 复算。
 */
app.post('/api/rubrics/gate', requireRole('evaluator'), async (req, res) => {
  const { key, version, scores } = req.body ?? {};
  try {
    ok(res, await runGate({ key, version, scores }));
  } catch (e) {
    if (e instanceof RubricError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

app.post('/api/rubrics/:key/activate', requireRole('admin'), async (req, res) => {
  try {
    ok(res, await activateRubric(req.params.key, req.body?.version));
  } catch (e) {
    if (e instanceof RubricError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────── 数据中台：血缘 + 质量 ───────────────────────────────

/** 全量血缘图：派生边 + 外部事件边，并附当前追不到的缺口 */
app.get('/api/lineage/graph', async (_req, res) => {
  try {
    ok(res, await lineageGraph());
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 上游/下游追溯。id 里可能含 @ 或 /，一律走 query 而非路径参数 */
app.get('/api/lineage/walk', async (req, res) => {
  const { type, id, direction = 'downstream' } = req.query;
  if (!type || !id) return fail(res, 400, 'type 与 id 必填');
  if (!['upstream', 'downstream'].includes(direction)) {
    return fail(res, 400, 'direction 只能是 upstream / downstream');
  }
  try {
    ok(res, await lineageWalk(type, id, direction));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 派生边可随时重建；重建是幂等的，不清空外部事件边 */
app.post('/api/lineage/rebuild', requireRole('admin'), async (_req, res) => {
  try {
    const events = await seedEvents();
    ok(res, { ...(await rebuildLineage()), external_events: events });
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get('/api/dq/rules', async (_req, res) => {
  try {
    ok(res, await listRules());
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 执行质量检查会写库，限 evaluator；规则 SQL 只来自服务端注册 */
app.post('/api/dq/run', requireRole('evaluator'), async (_req, res) => {
  try {
    ok(res, await runChecks());
  } catch (e) {
    if (e instanceof DqError) return fail(res, e.status, e.message);
    fail(res, 500, e.message);
  }
});

app.get('/api/dq/report', async (_req, res) => {
  try {
    const report = await latestReport();
    if (!report) return fail(res, 404, '尚未执行过质量检查');
    ok(res, report);
  } catch (e) {
    fail(res, 500, e.message);
  }
});

app.get('/api/dq/history', async (req, res) => {
  try {
    ok(res, await dqHistory(req.query.limit));
  } catch (e) {
    fail(res, 500, e.message);
  }
});

/** 注册内置规则（幂等），供部署脚本调用；不放开客户端自定义 SQL */
app.post('/api/dq/seed', requireRole('admin'), async (_req, res) => {
  try {
    ok(res, await seedRules());
  } catch (e) {
    fail(res, 500, e.message);
  }
});

// ─────────────────────────────── 兜底 ───────────────────────────────

app.use((req, res) => fail(res, 404, `未知接口：${req.method} ${req.path}`));

app.use((err, _req, res, _next) => {
  console.error('[EvalHub] 未捕获异常：', err);
  fail(res, 500, err.message || '服务器内部错误');
});

// 评测队列需要仓储来定位数据集；启动时把遗留的 running 任务标记为中断
attachRepo(repoRef());
const recovered = await recoverStaleRuns();
if (recovered.recovered) {
  console.log(`  [队列] 发现 ${recovered.recovered} 个上次未跑完的任务，已标记为 failed`);
}
startWorker();

app.listen(PORT, HOST, () => {
  const s = glmStatus();
  const st = storageInfo();
  console.log('─'.repeat(60));
  console.log('  EvalHub backend 已启动');
  console.log(`  监听        : ${HOST}:${PORT}${HOST === '127.0.0.1' ? '（仅本机，公网请走 nginx）' : ''}`);
  console.log(`  引擎版本    : ${engineVersion()}`);
  console.log(`  引擎产物    : ${ENGINE_BUILD}`);
  console.log(`  数据存储    : ${st.mode === 'postgres' ? `PostgreSQL · ${st.dataset}@v${st.version}` : `JSON · ${st.source}`}`);
  console.log(`  评测队列    : 并发 ${queueStats().concurrency}（POST /api/runs 创建任务）`);
  const a = authStatus();
  console.log(`  鉴权        : ${a.enabled ? `已启用（令牌 ${a.token_ttl_seconds}s，密钥来源 ${a.secret_source}）` : '未启用（设 EVALHUB_AUTH=1 打开）'}`);
  console.log(`  大模型      : ${s.model}（${s.ready ? '已配置密钥，来源 ' + s.key_source : '未配置密钥，仅 /api/score 可用'}）`);
  console.log('─'.repeat(60));
});
