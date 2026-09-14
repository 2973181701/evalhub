/**
 * EvalHub · Node 网关（HTTP 服务）
 *
 * 三层架构里的中间层，只做三件事：
 *   1. 调 GLM API 生成回答（唯一需要网络的环节）
 *   2. 把文本丢给 MoonBit 核心引擎做纯计算（打分 / 校验 / 统计 / 导出）
 *   3. 把结果用 HTTP 暴露给 Vue 前端
 *
 * 启动： node server.js        （默认 http://localhost:3000）
 * 环境变量： PORT / GLM_API_KEY / GLM_BASE_URL / GLM_MODEL / GLM_MIN_INTERVAL_MS
 */

import express from 'express';
import cors from 'cors';
import { engineVersion, ENGINE_BUILD, score, validateAnnotation } from './engine.js';
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
} from './store.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);

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
app.post('/api/annotate', (req, res) => {
  const payload = req.body ?? {};
  if (!payload.id) return fail(res, 400, '缺少 id');
  const result = submitAnnotation(payload);
  if (!result.accepted) {
    return res.status(422).json({ ok: false, error: '标注未通过校验', check: result.check });
  }
  ok(res, {
    check: result.check,
    record: result.record,
    annotated_count: annotations().length,
  });
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
app.post('/api/export', (req, res) => {
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

// ─────────────────────────────── 兜底 ───────────────────────────────

app.use((req, res) => fail(res, 404, `未知接口：${req.method} ${req.path}`));

app.use((err, _req, res, _next) => {
  console.error('[EvalHub] 未捕获异常：', err);
  fail(res, 500, err.message || '服务器内部错误');
});

app.listen(PORT, () => {
  const s = glmStatus();
  console.log('─'.repeat(60));
  console.log('  EvalHub backend 已启动');
  console.log(`  地址        : http://localhost:${PORT}`);
  console.log(`  引擎版本    : ${engineVersion()}`);
  console.log(`  引擎产物    : ${ENGINE_BUILD}`);
  console.log(`  大模型      : ${s.model}（${s.ready ? '已配置密钥，来源 ' + s.key_source : '未配置密钥，仅 /api/score 可用'}）`);
  console.log('─'.repeat(60));
});
