/**
 * EvalHub · JSON 仓储（默认 / 兜底）
 *
 * 与改造前 store.js 的行为完全一致：
 *   - 只读快照 data/*.json，进程内缓存一次
 *   - 运行期提交的标注落盘 data/out/annotations_submitted.json
 *   - 同一 id 以最新提交覆盖种子标注
 *
 * 这是「零依赖可跑」路径：没有 PostgreSQL 也能跑全套接口。
 */

import fs from 'node:fs';
import path from 'node:path';

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

export function createJsonRepo({ dataDir }) {
  const outDir = path.join(dataDir, 'out');
  const submittedFile = path.join(outDir, 'annotations_submitted.json');

  let cache = null;

  function ensureData() {
    const missing = ['prompts.json', 'pairs.json', 'annotations.json'].filter(
      (f) => !fs.existsSync(path.join(dataDir, f)),
    );
    if (missing.length) {
      throw new Error(
        `缺少数据文件：${missing.join(', ')}。请先在 evalhub 根目录执行： node tools/build_dataset.mjs`,
      );
    }
  }

  function load() {
    if (cache) return cache;
    ensureData();
    const prompts = readJson(path.join(dataDir, 'prompts.json'), []);
    const pairs = readJson(path.join(dataDir, 'pairs.json'), []);
    const answers = readJson(path.join(dataDir, 'answers.json'), []);
    const seeds = readJson(path.join(dataDir, 'annotations.json'), []);
    const submitted = readJson(submittedFile, []);
    cache = {
      prompts,
      pairs,
      answers,
      seeds,
      submitted,
      byId: {
        prompt: new Map(prompts.map((p) => [p.id, p])),
        pair: new Map(pairs.map((p) => [p.id, p])),
        answer: new Map(answers.map((a) => [a.id, a])),
      },
    };
    return cache;
  }

  return {
    mode: 'json',
    describe: () => ({ mode: 'json', source: path.relative(process.cwd(), dataDir) }),
    /** JSON 模式没有数据集版本概念，给一个稳定的伪 ref，保证调用方逻辑一致 */
    datasetRef: () => ({ id: null, name: 'json-snapshot', version: 1 }),
    snapshot: load,
    annotations() {
      const { seeds, submitted } = load();
      const map = new Map(seeds.map((a) => [a.id, { ...a, source: 'seed' }]));
      for (const a of submitted) map.set(a.id, { ...a, source: 'submitted' });
      return [...map.values()];
    },
    async saveAnnotation(record) {
      const { submitted } = load();
      const idx = submitted.findIndex((x) => x.id === record.id);
      if (idx >= 0) submitted[idx] = record;
      else submitted.push(record);
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(submittedFile, JSON.stringify(submitted, null, 2), 'utf8');
    },
  };
}
