#!/usr/bin/env node
/**
 * EvalHub · CI 质量门禁
 *
 * 这是「评测中台」真正接入研发流程的那一步：模型/prompt 改动后自动跑评测，
 * **不达标就阻断发布**，而不是靠人记得去看报告。
 *
 * 用法（CI 里）：
 *   EVALHUB_API_KEY=ehk_xxx node tools/gate_check.mjs --base http://127.0.0.1:3000 \
 *     --provider local --ids K01,K02,K03 --rubric evalhub-core
 *
 *   # 与基线对比，允许的最大回退幅度 0.05
 *   ... --baseline 6f3c... --max-regress 0.05
 *
 * 退出码（CI 靠它判断）：
 *   0  通过
 *   2  门禁不通过（低于 rubric 阈值）
 *   3  相对基线回退超限
 *   1  执行错误（网络/鉴权/任务失败）
 *
 * 为什么把「回退」和「不达标」分成两个码：两者的处置不同。
 * 不达标是「这次改动就很差」；回退是「本来能过，但比上次差了」——
 * 后者说明是本次改动引入的退化，定位范围小得多。
 */

import { EvalHubClient, EvalHubError } from '../sdk/evalhub-client.mjs';

const argv = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt;
};
const flag = (name) => argv.includes(name);

const BASE = arg('--base', process.env.EVALHUB_BASE || 'http://127.0.0.1:3000');
const API_KEY = arg('--api-key', process.env.EVALHUB_API_KEY || null);
const TOKEN = arg('--token', process.env.EVALHUB_TOKEN || null);
const TENANT = arg('--tenant', process.env.EVALHUB_TENANT || null);
const PROVIDER = arg('--provider', 'local');
const RUBRIC = arg('--rubric', 'evalhub-core');
const IDS = arg('--ids', null);
const BASELINE = arg('--baseline', null);
const MAX_REGRESS = Number(arg('--max-regress', '0'));
const TIMEOUT_MS = Number(arg('--timeout', String(10 * 60_000)));
// 样本量门槛：3 条里 1 条低分就占 33%，会直接超过 rubric 的 25% 失败率上限，
// 把「小样本噪声」误判成「模型变差」。这种门禁比没有门禁更糟 —— 它会被团队直接关掉。
const MIN_SAMPLES = Number(arg('--min-samples', '10'));
const JSON_OUT = flag('--json');

function die(code, message) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: false, code, error: message }));
  else console.error(`\n❌ ${message}`);
  process.exit(code);
}

function fmt(n, w = 6) {
  return n === null || n === undefined ? '—'.padStart(w) : Number(n).toFixed(2).padStart(w);
}

async function resolveBaseline(client) {
  if (!BASELINE) return null;
  if (BASELINE !== 'latest') return BASELINE;
  // 只取同 provider 的最近一次成功任务，避免拿 glm 的结果当 local 的基线
  const { runs } = await client.request('/api/runs?limit=20');
  const hit = runs.find((r) => r.status === 'succeeded' && r.provider === PROVIDER);
  if (!hit) return null;
  return hit.id;
}

async function main() {
  if (!API_KEY && !TOKEN) {
    die(1, '需要 --api-key（推荐）或 --token；CI 里请用 API Key，JWT 会过期');
  }

  const client = new EvalHubClient({ baseUrl: BASE, apiKey: API_KEY, token: TOKEN, tenant: TENANT });

  const health = await client.health().catch((e) => die(1, `无法连接 ${BASE}：${e.message}`));
  if (!health.tenant) die(1, '后端未返回租户上下文，请确认已应用多租户迁移');

  if (!JSON_OUT) {
    console.log(`EvalHub 门禁 · ${BASE}`);
    console.log(`  业务线 ${health.tenant.slug}（${health.tenant.enforced ? '强制' : '未强制'}）· 存储 ${health.storage.mode}`);
    console.log(`  口径 ${RUBRIC} · provider ${PROVIDER}${IDS ? ` · 题号 ${IDS}` : ' · 全量'}`);
  }

  const ids = IDS ? IDS.split(',').map((s) => s.trim()).filter(Boolean) : undefined;

  let outcome;
  try {
    outcome = await client.runAndAggregate({
      provider: PROVIDER,
      ids,
      config: { ci: true, runner: process.env.CI_JOB_ID || 'local' },
      timeoutMs: TIMEOUT_MS,
      onProgress: JSON_OUT ? null : (run) => {
        process.stdout.write(`\r  评测进度 ${run.done_items}/${run.total_items}   `);
      },
    });
  } catch (e) {
    die(1, `评测执行失败：${e.message}`);
  }
  if (!JSON_OUT) process.stdout.write('\n');

  const { run, aggregate } = outcome;

  // 任务本体失败（比如模型 5xx 全挂）不能当成「分数低」，必须单独报错
  if (run.status !== 'succeeded') {
    die(1, `评测任务未成功：${run.status}${run.error ? ` · ${run.error}` : ''}`);
  }
  if (!aggregate.n) die(1, '没有任何有效评分样本，无法判定');
  if (aggregate.n < MIN_SAMPLES) {
    die(1, `有效样本 ${aggregate.n} 条 < 门槛 ${MIN_SAMPLES} 条，拒绝出结论。`
      + '小样本下失败率会被单条噪声放大（3 条里 1 条低分就是 33%），'
      + '要么用全量题集，要么显式调低 --min-samples。');
  }

  // 门禁判定走服务端口径，保证与平台内看到的结论完全一致（同一份纯函数）
  const rows = await client.results(run.id);
  const gate = await client.gate({ key: RUBRIC, scores: rows });

  // 基线对比
  let baseline = null;
  const baseId = await resolveBaseline(client).catch(() => null);
  if (baseId && baseId !== run.id) {
    const baseAgg = await client.aggregate(baseId);
    baseline = {
      run_id: baseId,
      total: baseAgg.total,
      delta: baseAgg.total === null ? null : Number((aggregate.total - baseAgg.total).toFixed(4)),
    };
  }

  const regressed = baseline?.delta !== null && baseline?.delta !== undefined && baseline.delta < -MAX_REGRESS;
  const pass = gate.pass && !regressed;

  const report = {
    ok: pass,
    run_id: run.id,
    tenant: health.tenant.slug,
    provider: PROVIDER,
    rubric: gate.rubric,
    n: aggregate.n,
    failed_items: aggregate.failed,
    total: aggregate.total,
    dims: aggregate.dims,
    gate: { pass: gate.pass, reasons: gate.reasons, metrics: gate.metrics },
    baseline,
    max_regress: MAX_REGRESS,
    regressed,
  };

  if (JSON_OUT) {
    console.log(JSON.stringify(report));
  } else {
    console.log('\n  指标        本轮' + (baseline ? '     基线    差值' : ''));
    console.log(`  总分      ${fmt(aggregate.total)}` + (baseline ? `${fmt(baseline.total)}${fmt(baseline.delta)}` : ''));
    for (const [k, v] of Object.entries(aggregate.dims)) {
      console.log(`  ${k.padEnd(12)}${fmt(v)}`);
    }
    console.log(`\n  样本 ${aggregate.n} 条${aggregate.failed ? `（另有 ${aggregate.failed} 条失败）` : ''}`);
    if (!gate.pass) {
      console.log('\n  门禁未通过：');
      for (const r of gate.reasons) console.log(`   - ${r}`);
    } else {
      console.log('  门禁通过 ✓');
    }
    if (baseline) {
      console.log(`  基线 ${baseline.run_id.slice(0, 8)} 总分 ${baseline.total}，差值 ${baseline.delta >= 0 ? '+' : ''}${baseline.delta}（允许回退 ${MAX_REGRESS}）`);
    }
  }

  // 退出码即结论，不再往输出里补一句 —— CI 日志里重复报同一件事只会干扰阅读
  if (!gate.pass) process.exit(2);
  if (regressed) process.exit(3);
  process.exit(0);
}

main().catch((e) => {
  if (e instanceof EvalHubError) die(1, `接口错误（${e.status || '网络'}）：${e.message}`);
  die(1, e.message);
});
