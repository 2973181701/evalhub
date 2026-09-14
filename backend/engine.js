/**
 * EvalHub · MoonBit 核心引擎加载器
 *
 * 职责：把 `moon build --target js` 编译出的强类型引擎接进 Node。
 * 优先用 release 产物，找不到就退回 debug 产物。
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(HERE, '..', 'core');

const CANDIDATES = [
  path.join(CORE, '_build/js/release/build/src/src.js'),
  path.join(CORE, '_build/js/debug/build/src/src.js'),
];

export function enginePath() {
  for (const p of CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

const found = enginePath();
if (!found) {
  console.error('✗ 找不到 MoonBit 引擎编译产物。');
  console.error('  请先执行：  cd core && moon build --target js');
  process.exit(1);
}

const mbt = await import(pathToFileURL(found).href);

/** 引擎产物路径（用于 /api/health 自证） */
export const ENGINE_BUILD = path.relative(path.resolve(HERE, '..'), found).replace(/\\/g, '/');

/** 五维评测引擎：JSON 进 JSON 出 */
export function score(input) {
  return JSON.parse(mbt.eval_engine(JSON.stringify(input)));
}

/** 标注校验引擎 */
export function validateAnnotation(input) {
  return JSON.parse(mbt.annotate_engine(JSON.stringify(input)));
}

/** 分析引擎：均分 / 雷达图 / 需复核样本 */
export function analyze(input) {
  return JSON.parse(mbt.analyze_engine(JSON.stringify(input)));
}

/** 一致性引擎：成对一致率 / 全票一致率 / Fleiss' κ */
export function consistency(input) {
  return JSON.parse(mbt.consistency_engine(JSON.stringify(input)));
}

/** 数据引擎：RLHF 偏好训练集导出 */
export function exportRlhf(input) {
  return JSON.parse(mbt.export_rlhf(JSON.stringify(input)));
}

/** 引擎版本号 */
export function engineVersion() {
  return mbt.version();
}
