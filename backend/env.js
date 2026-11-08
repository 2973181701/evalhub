/**
 * EvalHub · 极简 .env 加载器（无第三方依赖）
 *
 * 为什么需要它：pm2 的 `--update-env` 只刷新「当前 shell 的环境变量」，
 * 不会去读 .env 文件。结果就是：密钥明明写进了 backend/.env，
 * 重启后 health 仍显示 key_source=未找到 —— 这个坑排查成本极高。
 *
 * 规则：
 *   - 只读 backend/.env，不递归找上级目录（避免误读开发机上的配置）
 *   - **不覆盖**已存在的环境变量：命令行/系统 env 的优先级更高
 *   - 支持 `KEY=value`、`#` 注释、值两端的引号；不做变量插值（不需要，也容易出错）
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENV_FILE = process.env.EVALHUB_ENV_FILE || path.join(HERE, '.env');

export function loadEnv(file = ENV_FILE) {
  if (!fs.existsSync(file)) return { loaded: 0, file, found: false };
  const text = fs.readFileSync(file, 'utf8');
  let loaded = 0;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] !== undefined) continue; // 已有环境变量优先
    process.env[key] = value;
    loaded += 1;
  }
  return { loaded, file, found: true };
}

const result = loadEnv();

export const envInfo = {
  file: path.basename(result.file),
  found: result.found,
  loaded: result.loaded,
};
