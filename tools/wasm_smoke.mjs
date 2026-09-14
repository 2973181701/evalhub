#!/usr/bin/env node
/**
 * EvalHub · WASM 形态一致性冒烟测试（P4 进阶项验收）
 *
 * ## 这个脚本在验什么
 *
 * 同一套 MoonBit 引擎源码，编成两种目标：
 *   - js      目标 → core/_build/js/debug/build/src/src.js        （后端在用）
 *   - wasm-gc 目标 → core/_build/wasm-gc/debug/build/src/src.wasm （本脚本在验）
 *
 * 「编出 .wasm 文件」不等于「WASM 形态真的能用」。本脚本用**真实数据**把五个引擎
 * 各跑一遍，把两种目标的输出做**严格字符串比对**（=== + 逐码元比对）。
 * 只要有一个字符不同就报错退出（exit 1），保证「WASM 能跑」是实测结论而不是声称。
 *
 * ## 为什么 WASM 侧要走 ABI
 *
 * wasm-gc 的 String 是 GC 结构体，JS 侧造不出也读不出（详见 src/engine_wasm_abi.mbt 头注释）。
 * 所以 WASM 侧统一走「码点缓冲 + 索引寻址」的 abi_* 函数，只传 Int。
 *
 * ⚠️ 搬的是**码点**（`codePointAt` / `fromCodePoint`），不是 UTF-16 码元
 * （`charCodeAt` / `fromCharCode`）。MoonBit 的 Char 是 32 位完整码点，
 * 传码元会让代理对被 `Int::to_char` 判为非法、替换成 U+FFFD，非 BMP 字符就丢了。
 *
 * 运行：node tools/wasm_smoke.mjs（在 evalhub 根目录）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  version as jsVersion,
  eval_engine as jsEval,
  annotate_engine as jsAnnotate,
  analyze_engine as jsAnalyze,
  consistency_engine as jsConsistency,
  export_rlhf as jsExportRlhf,
} from '../core/_build/js/debug/build/src/src.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DATA = path.join(ROOT, 'data');
const WASM_PATH = path.join(ROOT, 'core/_build/wasm-gc/debug/build/src/src.wasm');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/* ══════════════════════════ WASM 侧：ABI 包装 ══════════════════════════ */

const wasmBytes = fs.readFileSync(WASM_PATH);
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const w = instance.exports;

const OPS = { eval: 0, annotate: 1, analyze: 2, consistency: 3, export_rlhf: 4 };
const CHUNK = 4096; // 分块调用，避免一次推/读太多码点

/** 从 ABI 缓冲区读回 JS 字符串（按码点重组） */
function readBuf() {
  const n = w.abi_len();
  const parts = [];
  for (let i = 0; i < n; i += CHUNK) {
    const end = Math.min(i + CHUNK, n);
    const codes = new Array(end - i);
    for (let j = i; j < end; j++) codes[j - i] = w.abi_read(j);
    parts.push(String.fromCodePoint(...codes));
  }
  return parts.join('');
}

/** 把 JS 字符串推进 ABI 缓冲区（按码点拆分，不是 charCodeAt） */
function writeBuf(s) {
  w.abi_clear();
  let batch = [];
  for (const ch of s) {
    batch.push(ch.codePointAt(0));
    if (batch.length >= CHUNK) {
      for (const cp of batch) w.abi_push(cp);
      batch = [];
    }
  }
  for (const cp of batch) w.abi_push(cp);
}

/** 走 ABI 调一次引擎 */
function wasmCall(op, input) {
  writeBuf(input);
  w.abi_run(op);
  return readBuf();
}

/** 走 ABI 取版本号 */
function wasmVersion() {
  w.abi_version();
  return readBuf();
}

/* ══════════════════════════ 比对工具 ══════════════════════════ */

let pass = 0;
let fail = 0;
const failures = [];

/** 严格比对两个字符串：长度 + 逐码元 */
function strictEqual(a, b) {
  if (a === b) return { ok: true };
  if (a.length !== b.length) {
    return { ok: false, why: `长度不同 js=${a.length} wasm=${b.length}` };
  }
  for (let i = 0; i < a.length; i++) {
    if (a.charCodeAt(i) !== b.charCodeAt(i)) {
      return {
        ok: false,
        why: `第 ${i} 个码元不同 js=U+${a.charCodeAt(i).toString(16).toUpperCase()} wasm=U+${b
          .charCodeAt(i)
          .toString(16)
          .toUpperCase()}`,
      };
    }
  }
  return { ok: false, why: '未知差异' };
}

/** 跑一个用例：jsFn 与 wasmOp 同输入，严格比对 */
function check(name, jsOut, wasmOut, bytes) {
  const r = strictEqual(jsOut, wasmOut);
  if (r.ok) {
    pass++;
    console.log(`  ✓ ${name.padEnd(46)} ${String(jsOut.length).padStart(6)} 码元  ${bytes}`);
    return true;
  }
  fail++;
  failures.push(`${name} —— ${r.why}`);
  console.log(`  ✗ ${name.padEnd(46)} ${r.why}`);
  return false;
}

const kb = (s) => `${(Buffer.byteLength(s, 'utf8') / 1024).toFixed(1)} KB`;

/* ══════════════════════════ 准备真实数据 ══════════════════════════ */

const prompts = readJson(path.join(DATA, 'prompts.json'));
const answers = readJson(path.join(DATA, 'answers.json'));
const pairs = readJson(path.join(DATA, 'pairs.json'));
const annotations = readJson(path.join(DATA, 'annotations.json'));
const scores = readJson(path.join(DATA, 'out', 'scores.json'));

const answerById = new Map(answers.map((a) => [a.id, a.answer]));
const pairById = new Map(pairs.map((p) => [p.id, p]));

/* ══════════════════════════ 开跑 ══════════════════════════ */

console.log('');
console.log('═'.repeat(78));
console.log('EvalHub · WASM 形态一致性冒烟测试');
console.log('═'.repeat(78));
console.log(`  wasm 产物 : ${path.relative(ROOT, WASM_PATH)}`);
console.log(`  wasm 体积 : ${(wasmBytes.length / 1024).toFixed(1)} KB`);
console.log(`  导出函数  : ${WebAssembly.Module.exports(new WebAssembly.Module(wasmBytes)).length} 个`);
console.log(`  导入依赖  : ${WebAssembly.Module.imports(new WebAssembly.Module(wasmBytes)).length} 个`);
console.log('');

/* ---------- 0. 版本号 ---------- */
console.log('【0】版本号');
check('version()', jsVersion(), wasmVersion(), kb(jsVersion()));

/* ---------- 1. 评测引擎：20 条真实回答 ---------- */
console.log('\n【1】评测引擎 eval_engine —— 20 条真实回答逐条比对');
{
  let ok = 0;
  let totalBytes = 0;
  for (const p of prompts) {
    const input = JSON.stringify({
      prompt: p.prompt,
      answer: answerById.get(p.id) ?? '',
      reference: p.reference ?? '',
      task_type: p.task_type,
    });
    const a = jsEval(input);
    const b = wasmCall(OPS.eval, input);
    totalBytes += Buffer.byteLength(a, 'utf8');
    if (strictEqual(a, b).ok) ok++;
    else {
      fail++;
      failures.push(`eval_engine(${p.id}) 输出不一致`);
    }
  }
  pass += ok;
  console.log(`  ${ok === prompts.length ? '✓' : '✗'} 20 条全部一致：${ok}/${prompts.length}  合计 ${(totalBytes / 1024).toFixed(1)} KB`);
}

/* ---------- 2. 标注引擎：20 条真实标注 ---------- */
console.log('\n【2】标注引擎 annotate_engine —— 20 条真实人工标注逐条比对');
{
  let ok = 0;
  let totalBytes = 0;
  for (const a0 of annotations) {
    const pair = pairById.get(a0.id) ?? {};
    const input = JSON.stringify({
      id: a0.id,
      answer_A: pair.answer_A ?? '',
      answer_B: pair.answer_B ?? '',
      choice: a0.choice,
      reason: a0.reason,
      confidence: a0.confidence,
    });
    const a = jsAnnotate(input);
    const b = wasmCall(OPS.annotate, input);
    totalBytes += Buffer.byteLength(a, 'utf8');
    if (strictEqual(a, b).ok) ok++;
    else {
      fail++;
      failures.push(`annotate_engine(${a0.id}) 输出不一致`);
    }
  }
  pass += ok;
  console.log(`  ${ok === annotations.length ? '✓' : '✗'} 20 条全部一致：${ok}/${annotations.length}  合计 ${(totalBytes / 1024).toFixed(1)} KB`);
}

/* ---------- 3. 分析引擎 ---------- */
console.log('\n【3】分析引擎 analyze_engine —— 全量统计报告');
{
  const input = JSON.stringify({ scores });
  const a = jsAnalyze(input);
  const b = wasmCall(OPS.analyze, input);
  check(`{scores} 全量 ${scores.length} 条`, a, b, kb(a));
}

/* ---------- 4. 一致性引擎 ---------- */
console.log('\n【4】一致性引擎 consistency_engine');
{
  // 4a. 人工 vs 规则引擎（与 build_dataset.mjs 同构造）
  const ruleJudge = readJson(path.join(DATA, 'out', 'rule_judge.json'));
  const records = [
    ...annotations.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
    ...ruleJudge.map((e) => ({ id: e.id, annotator: 'rule_judge', choice: e.choice })),
  ];
  const in1 = JSON.stringify({ records });
  check('人工 vs 规则引擎（40 条记录）', jsConsistency(in1), wasmCall(OPS.consistency, in1), kb(jsConsistency(in1)));

  // 4b. 单人标注 → κ 应返回 null + 原因（诚实降级路径）
  const in2 = JSON.stringify({
    records: annotations.map((a) => ({ id: a.id, annotator: 'human', choice: a.choice })),
  });
  check('单人标注 → κ=null 降级', jsConsistency(in2), wasmCall(OPS.consistency, in2), kb(jsConsistency(in2)));
}

/* ---------- 5. 数据引擎 ---------- */
console.log('\n【5】数据引擎 export_rlhf —— 两种导出格式');
{
  const merged = annotations.map((a) => {
    const pair = pairById.get(a.id) ?? {};
    return {
      id: a.id,
      task_type: a.task_type,
      prompt: pair.prompt ?? '',
      answer_A: pair.answer_A ?? '',
      answer_B: pair.answer_B ?? '',
      choice: a.choice,
    };
  });
  for (const format of ['dpo', 'openai']) {
    const input = JSON.stringify({ format, annotations: merged });
    check(`format=${format}（${merged.length} 条输入）`, jsExportRlhf(input), wasmCall(OPS.export_rlhf, input), kb(jsExportRlhf(input)));
  }
}

/* ---------- 6. 边界与错误路径 ---------- */
console.log('\n【6】边界与错误路径（非法输入不能崩、两种目标行为要一致）');
{
  const bad = [
    ['eval', OPS.eval, jsEval, 'not-a-json'],
    ['eval', OPS.eval, jsEval, '{}'],
    ['annotate', OPS.annotate, jsAnnotate, '[]'],
    ['analyze', OPS.analyze, jsAnalyze, 'null'],
    ['consistency', OPS.consistency, jsConsistency, '{"records":[]}'],
    ['export_rlhf', OPS.export_rlhf, jsExportRlhf, '{"format":"csv","annotations":[]}'],
    ['export_rlhf', OPS.export_rlhf, jsExportRlhf, ''],
    // 含 Unicode 同形字符（下标 ₂），验证码元搬运没丢字
    [
      'eval',
      OPS.eval,
      jsEval,
      JSON.stringify({
        prompt: '水的化学式？',
        answer: '水的化学式是H₂O。',
        reference: 'H2O',
        task_type: '事实问答',
      }),
    ],
    // 含 emoji（代理对，占 2 个码元），验证 UTF-16 码元搬运正确
    [
      'eval',
      OPS.eval,
      jsEval,
      JSON.stringify({
        prompt: '写一句鼓励的话',
        answer: '加油！你一定能行 💪🔥',
        reference: '应包含鼓励性表达',
        task_type: '创意写作',
      }),
    ],
  ];
  for (const [label, op, jsFn, input] of bad) {
    const shown = input.length > 34 ? input.slice(0, 34) + '…' : input;
    const a = jsFn(input);
    const b = wasmCall(op, input);
    check(`${label} ← ${shown}`, a, b, kb(a));
  }
}

/* ---------- 7. 非 BMP 字符往返（输出会原样回显输入文本） ---------- */
console.log('\n【7】非 BMP 字符往返 —— 输出原样回显输入，验证码点搬运双向无损');
{
  // export_rlhf 的输出里含 prompt / chosen / rejected 原文，
  // 所以这是唯一能把「输入文本 → 输出文本」整条往返链路验穿的用例。
  // 若 ABI 误搬 UTF-16 码元，emoji 会在输出里变成 U+FFFD，此用例必然失败。
  const emojiCases = [
    {
      name: 'emoji（U+1F4AA / U+1F525）',
      answer_A: '加油！你一定能行 💪🔥',
      answer_B: '加油，你可以的。',
    },
    {
      name: '生僻字（U+2000B / U+2A6A5）',
      answer_A: '𠀋𪚥 这些是扩展区汉字',
      answer_B: '这些是普通汉字',
    },
    {
      name: '混排：emoji + 下标同形 + 全角数字',
      answer_A: 'H₂O 是水，温度 １００℃ 🔥',
      answer_B: '水是 H2O',
    },
    {
      name: '组合字符（带变音符号）',
      answer_A: 'café 与 café（é 分别是单码点与组合序列）',
      answer_B: 'cafe',
    },
  ];
  for (const c of emojiCases) {
    const input = JSON.stringify({
      format: 'dpo',
      annotations: [
        {
          id: 'X01',
          task_type: '创意写作',
          prompt: '测试非 BMP 字符往返',
          answer_A: c.answer_A,
          answer_B: c.answer_B,
          choice: 'A',
        },
      ],
    });
    const jsOut = jsExportRlhf(input);
    const wasmOut = wasmCall(OPS.export_rlhf, input);
    const ok = check(c.name, jsOut, wasmOut, kb(jsOut));
    if (ok) {
      // 额外确认输出里确实含原字符，而不是两边都退化成了 U+FFFD
      const echoed = jsOut.includes(c.answer_A);
      const clean = !jsOut.includes('\uFFFD');
      if (echoed && clean) {
        pass++;
        console.log(`    └ 回显校验 ✓ 原字符完整出现在输出中，且无 U+FFFD`);
      } else {
        fail++;
        failures.push(`${c.name} 回显校验失败（含原字符=${echoed} 无替换符=${clean}）`);
        console.log(`    └ 回显校验 ✗ 含原字符=${echoed} 无替换符=${clean}`);
      }
    }
  }
}

/* ---------- 8. 未知 op 码 ---------- */
console.log('\n【8】未知 op 码（宿主传错数字时的兜底）');
{
  writeBuf('{}');
  w.abi_run(99);
  const out = readBuf();
  const expected = '{"error":"unknown_op"}';
  const r = strictEqual(expected, out);
  if (r.ok) {
    pass++;
    console.log(`  ✓ abi_run(99) → ${out}`);
  } else {
    fail++;
    failures.push(`abi_run(99) 期望 ${expected}，实际 ${out}`);
    console.log(`  ✗ abi_run(99) → ${out}（期望 ${expected}）`);
  }
}

/* ══════════════════════════ 汇总 ══════════════════════════ */

console.log('\n' + '═'.repeat(78));
console.log(`结果：${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log('\n失败明细：');
  for (const f of failures) console.log('  · ' + f);
  console.log('\n结论：WASM 形态与 JS 形态输出**不一致**，不能声称 WASM 可用。');
  process.exit(1);
}
console.log('');
console.log('结论：五个引擎在 wasm-gc 形态下的输出与 js 形态**逐字节完全一致**。');
console.log('      WASM 产物自包含（0 个导入），走 abi_* 码点缓冲 ABI 与宿主通信。');
console.log('═'.repeat(78));
console.log('');
