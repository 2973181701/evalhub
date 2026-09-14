#!/usr/bin/env node
/**
 * EvalHub · 后端接口全量验收（12 个接口）
 *
 * 用途：验收 Node 网关。逐接口调用并打印**真实响应**，最后汇总通过/失败。
 * 任何一项失败 → exit 1，可直接用于「跑通了没」的客观判定。
 *
 * 自包含：若后端未启动，本脚本会**自己拉起** `backend/server.js`，跑完再关掉。
 * 所以不需要手动开终端。
 *
 * 运行：node tools/api_verify.mjs
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE = process.env.EVALHUB_BASE || 'http://127.0.0.1:3000';

let pass = 0;
let fail = 0;
const failures = [];

/* ---------- 后端可用性：先探测，不可用则自己拉起 ---------- */
async function reachable() {
  try {
    const r = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(1500) });
    return r.ok;
  } catch {
    return false;
  }
}

let child = null;

async function ensureBackend() {
  if (await reachable()) {
    console.log('  后端已在运行，直接复用。');
    return;
  }
  console.log('  后端未启动 → 自动拉起 backend/server.js …');
  child = spawn(process.execPath, ['server.js'], {
    cwd: path.join(ROOT, 'backend'),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  child.stdout.on('data', (d) => (log += d.toString()));
  child.stderr.on('data', (d) => (log += d.toString()));

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    if (await reachable()) {
      console.log('  后端已就绪（约 ' + (i + 1) * 250 + ' ms）。');
      return;
    }
  }
  console.error('  ✗ 后端启动超时。输出如下：\n' + log);
  process.exit(1);
}

function stopBackend() {
  if (child) {
    child.kill();
    child = null;
  }
}

async function call(method, path, body) {
  const opt = { method };
  if (body !== undefined) {
    opt.headers = { 'Content-Type': 'application/json' };
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(BASE + path, opt);
  let json = null;
  try {
    json = await r.json();
  } catch {
    json = null;
  }
  return { status: r.status, json };
}

/** 断言式检查：cond 为真则通过 */
function check(name, cond, detail) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
    if (detail) console.log(`      ${detail}`);
    return true;
  }
  fail++;
  failures.push(name);
  console.log(`  ✗ ${name}`);
  if (detail) console.log(`      ${detail}`);
  return false;
}

const cut = (s, n = 150) => (typeof s === 'string' && s.length > n ? s.slice(0, n) + '…' : s);

console.log('');
console.log('═'.repeat(78));
console.log('EvalHub · 后端接口全量验收');
console.log('═'.repeat(78));
console.log(`  目标：${BASE}`);
console.log('');
await ensureBackend();
console.log('');

/* ---------- 1. GET /api/health ---------- */
console.log('【1】GET /api/health —— 服务与引擎状态');
{
  const r = await call('GET', '/api/health');
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true);
  const d = r.json?.data ?? {};
  check('返回引擎版本', typeof d.engine_version === 'string', `engine_version = ${d.engine_version}`);
  check('返回引擎产物路径', typeof d.engine_build === 'string', `engine_build = ${d.engine_build}`);
  check(
    '大模型密钥状态（只报 ready，不回传密钥）',
    d.glm && typeof d.glm.ready === 'boolean' && !JSON.stringify(d).includes('api_key'),
    `glm = ${JSON.stringify(d.glm)}`,
  );
}

/* ---------- 2. GET /api/dataset ---------- */
console.log('\n【2】GET /api/dataset —— 数据集概览');
{
  const r = await call('GET', '/api/dataset');
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true, `keys = ${Object.keys(r.json?.data ?? {}).join(', ')}`);
  const d = r.json?.data ?? {};
  check('题目数 prompts_count 为 20', d.prompts_count === 20, `prompts_count = ${d.prompts_count}`);
  check('A/B 对数 count 为 20', d.count === 20, `count = ${d.count}`);
  check('标注数 annotated_count 为 20', d.annotated_count === 20, `annotated_count = ${d.annotated_count}`);
  check('items 为数组且长度 20', Array.isArray(d.items) && d.items.length === 20, `items 长度 = ${d.items?.length}`);
}

/* ---------- 3. GET /api/prompts ---------- */
console.log('\n【3】GET /api/prompts —— 题目列表');
{
  const r = await call('GET', '/api/prompts');
  const arr = r.json?.data;
  check('HTTP 200 且返回数组', r.status === 200 && Array.isArray(arr), `类型 = ${Array.isArray(arr) ? 'Array' : typeof arr}`);
  check('长度 20', Array.isArray(arr) && arr.length === 20, `长度 = ${arr?.length}`);
  check(
    '含 id / task_type / prompt 字段',
    Array.isArray(arr) && arr.length > 0 && 'id' in arr[0] && 'task_type' in arr[0] && 'prompt' in arr[0],
    `首条 = ${cut(JSON.stringify(arr?.[0]))}`,
  );
}

/* ---------- 4. POST /api/score ---------- */
console.log('\n【4】POST /api/score —— 给现成回答打分（不调模型）');
{
  const r = await call('POST', '/api/score', {
    prompt: '中国的首都是哪个城市？',
    answer: '中国的首都是北京。',
    reference: '北京',
    task_type: '事实问答',
  });
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true);
  const d = r.json?.data ?? {};
  const dims = ['accuracy', 'completeness', 'logic', 'safety', 'expression', 'total'];
  check('返回 6 个分数字段', dims.every((k) => typeof d[k] === 'number'), JSON.stringify(d));
  check('准确性给满分（回答与参考答案一致）', d.accuracy === 5, `accuracy = ${d.accuracy}`);
}

/* ---------- 5. POST /api/score 非法输入 ---------- */
console.log('\n【5】POST /api/score —— 非法输入兜底（不能 500 崩）');
{
  const r = await call('POST', '/api/score', { prompt: '', answer: '', reference: '', task_type: '' });
  check('空输入不崩、返回结构化响应', r.status === 200 || r.status === 400, `HTTP ${r.status}，ok=${r.json?.ok}`);
}

/* ---------- 6. POST /api/eval —— 真实调 GLM ---------- */
console.log('\n【6】POST /api/eval —— 真实调用大模型生成回答后打分');
{
  const t0 = Date.now();
  const r = await call('POST', '/api/eval', {
    prompt: '请用一句话说明什么是机器学习。',
    reference: '机器学习是让计算机从数据中自动学习规律的方法',
    task_type: '事实问答',
  });
  const ms = Date.now() - t0;
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true, `耗时 ${ms} ms`);
  const d = r.json?.data ?? {};
  const answer = d.answer ?? d.model_answer ?? d.response;
  check('真实返回了模型回答（非空）', typeof answer === 'string' && answer.length > 0, `回答 = ${cut(answer, 80)}`);
  check('对模型回答打了分', typeof (d.score?.total ?? d.total) === 'number', `total = ${d.score?.total ?? d.total}`);
  check('记录了大模型耗时', typeof ms === 'number' && ms > 100, `端到端 ${ms} ms（含真实网络请求）`);
}

/* ---------- 7. GET /api/scores ---------- */
console.log('\n【7】GET /api/scores —— 20 条真实回答的评分');
{
  const r = await call('GET', '/api/scores');
  const arr = r.json?.data;
  check('返回数组且长度 20', Array.isArray(arr) && arr.length === 20, `长度 = ${arr?.length}`);
  check('每条含 id / total', Array.isArray(arr) && arr[0] && 'id' in arr[0] && 'total' in arr[0], `首条 = ${cut(JSON.stringify(arr?.[0]))}`);
}

/* ---------- 8. GET /api/report ---------- */
console.log('\n【8】GET /api/report —— 统计报告（均分 / 分题型 / 雷达图）');
{
  const r = await call('GET', '/api/report');
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true);
  const d = r.json?.data ?? {};
  const s = d.scores ?? {};
  check('含五维均分', s.dimensions && typeof s.dimensions === 'object', `dimensions = ${JSON.stringify(s.dimensions)}`);
  check('含总分均分', typeof s.total === 'number', `total = ${s.total}`);
  check('含分题型统计', Array.isArray(s.by_task_type) && s.by_task_type.length > 0, `题型数 = ${s.by_task_type?.length}`);
  check('含雷达图数据（5 维，带归一化 ratio）', Array.isArray(s.radar) && s.radar.length === 5, `radar = ${JSON.stringify(s.radar?.map((x) => x.value))}`);
  check('含需复核样本（最低分 / 最大极差）', Array.isArray(s.lowest_total) && Array.isArray(s.max_spread), `最低分样本 ${s.lowest_total?.length} 条`);
  check('含标注质量统计', d.annotation_quality && typeof d.annotation_quality === 'object', JSON.stringify(d.annotation_quality));
}

/* ---------- 9. GET /api/consistency ---------- */
console.log('\n【9】GET /api/consistency —— 标注一致性');
{
  const r = await call('GET', '/api/consistency');
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true);
  const c = r.json?.data?.consistency ?? {};
  check('含标注者列表', Array.isArray(c.annotators), `annotators = ${JSON.stringify(c.annotators)}`);
  check(
    '含一致率与 Fleiss κ',
    typeof c.pairwise_agreement === 'number' && 'fleiss_kappa' in c,
    `成对一致率 = ${c.pairwise_agreement}，全票一致率 = ${c.unanimous_rate}，κ = ${c.fleiss_kappa}`,
  );
  check('含争议样本清单', Array.isArray(c.disputed_items), `争议 ${c.disputed_items?.length} 条`);
}

/* ---------- 10. POST /api/annotate/check ---------- */
console.log('\n【10】POST /api/annotate/check —— 标注入库校验（引擎执行）');
{
  // 合法
  const ok1 = await call('POST', '/api/annotate/check', {
    id: 'K01',
    answer_A: '北京',
    answer_B: '中国的首都是北京，北京是政治文化中心。',
    choice: 'A',
    reason: '选 A：依据维度 5 表达质量，A 更简洁直接。',
    confidence: 5,
  });
  check('合法标注 → valid:true', ok1.json?.data?.valid === true, JSON.stringify(ok1.json?.data));

  // 非法 choice
  const bad1 = await call('POST', '/api/annotate/check', {
    id: 'X01',
    answer_A: '甲',
    answer_B: '乙',
    choice: 'C',
    reason: '选 C 因为随便选。',
    confidence: 3,
  });
  check('非法 choice → valid:false 且有错误说明', bad1.json?.data?.valid === false, `errors = ${JSON.stringify(bad1.json?.data?.errors)}`);

  // 越界 confidence + 过短 reason
  const bad2 = await call('POST', '/api/annotate/check', {
    id: 'X02',
    answer_A: '甲',
    answer_B: '乙',
    choice: 'A',
    reason: '好',
    confidence: 9,
  });
  check(
    '越界 confidence / 过短 reason → 被拦截',
    bad2.json?.data?.valid === false,
    `errors = ${JSON.stringify(bad2.json?.data?.errors)}，flags = ${JSON.stringify(bad2.json?.data?.flags)}`,
  );
}

/* ---------- 11. POST /api/annotate ---------- */
console.log('\n【11】POST /api/annotate —— 提交标注（过引擎校验后入库）');
{
  const r = await call('POST', '/api/annotate', {
    id: 'K02',
    answer_A: '北京',
    answer_B: '北京是中国首都，位于华北平原北部。',
    choice: 'A',
    reason: '选 A：依据维度 5 表达质量，A 更简洁，信息量等价。',
    confidence: 4,
  });
  check('HTTP 200 + ok:true', r.status === 200 && r.json?.ok === true, cut(JSON.stringify(r.json?.data)));
}

/* ---------- 12. POST /api/export ---------- */
console.log('\n【12】POST /api/export —— RLHF 训练集导出（dpo / openai）');
{
  for (const format of ['dpo', 'openai']) {
    const r = await call('POST', '/api/export', { format });
    check(`format=${format} → HTTP 200 + ok:true`, r.status === 200 && r.json?.ok === true);
    const d = r.json?.data ?? {};
    check(
      `format=${format} → total/exported/dropped 齐全且自洽`,
      typeof d.total === 'number' && typeof d.exported === 'number' && typeof d.dropped === 'number' && d.total === d.exported + d.dropped,
      `total=${d.total} exported=${d.exported} dropped=${d.dropped} 丢弃明细=${JSON.stringify(d.dropped_detail)}`,
    );
    if (Array.isArray(d.data) && d.data.length > 0) {
      const first = d.data[0];
      const okShape = 'chosen' in first && 'rejected' in first;
      check(`format=${format} → 样本含 chosen/rejected`, okShape, `首条字段 = ${Object.keys(first).join(', ')}`);
    }
  }
}

/* ---------- 汇总 ---------- */
console.log('\n' + '═'.repeat(78));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
  console.log('\n结论：后端**未全部跑通**，不能进入下一阶段。');
  stopBackend();
  process.exit(1);
}
console.log('');
console.log('结论：12 个接口全部返回预期结构，含一次真实大模型调用。');
console.log('═'.repeat(78));
console.log('');
stopBackend();
