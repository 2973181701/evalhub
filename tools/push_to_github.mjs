#!/usr/bin/env node
/**
 * EvalHub → GitHub 上传工具（走 api.github.com REST，不依赖 git 协议）
 *
 * 为什么不用 git push：本机 github.com:443 直连被重置，git ls-remote 直接失败；
 * 但 api.github.com 可达。Git Data API 可以完成等价的一次 commit：
 *   GET  ref/heads/main → 拿到 base commit
 *   GET  commits/:sha   → 拿到 base tree
 *   POST git/trees      → 一次性提交全部文件（GitHub 自动建 blob）
 *   POST git/commits    → 建 commit
 *   PATCH git/refs/...  → 移动分支指针
 *
 * Token 来源（按优先级，**绝不写进仓库或日志**）：
 *   1. --token
 *   2. 环境变量 GITHUB_TOKEN / GH_TOKEN
 *   3. 文件 ~/.evalhub_github_token   ← 推荐：不用把 token 贴在对话里
 *   4. ~/.git-credentials 里 github.com 那一条
 *
 * 用法：
 *   node tools/push_to_github.mjs --dry-run            # 默认，只预览
 *   node tools/push_to_github.mjs --yes                # 真正推送
 *   node tools/push_to_github.mjs --yes --message "..." --branch main
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';

// ─────────────────────────── 参数 ───────────────────────────
const argv = process.argv.slice(2);
const arg = (k, d) => {
  const i = argv.indexOf(k);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d;
};
const REPO = arg('--repo', '2973181701/evalhub');
const BRANCH = arg('--branch', 'main');
const MESSAGE = arg('--message', 'feat: v2 企业级评测平台（PG 数据层 / 异步队列 / RBAC / LLM-as-Judge / 盲标留出集）');
const DO_IT = argv.includes('--yes');

// ─────────────────────────── 忽略规则 ───────────────────────────
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '_build', 'target',
  '.mooncakes', '.moonagent', 'out', '.vscode', '.idea',
]);
const EXCLUDE_FILES = new Set([
  'config.json', '.env', '.env.local', '.git-credentials',
  '.github-push-state.json', 'evalhub.zip', 'pg17.zip',
]);
const EXCLUDE_EXT = new Set(['.bak', '.log', '.tmp', '.key', '.pem', '.zip', '.tar', '.gz']);

// 内容层面的密钥模式：命中就整体拒绝上传，避免把 key 写进公开仓库
const SECRET_PATTERNS = [
  /[0-9a-f]{32}\.[A-Za-z0-9]{16,32}/,          // 智谱 key 形态
  /ghp_[A-Za-z0-9]{30,}/,
  /github_pat_[A-Za-z0-9_]{30,}/,
  /sk-[A-Za-z0-9]{32,}/,
  /-----BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY-----/,
];

function shouldExclude(rel) {
  const parts = rel.split(/[\\/]/);
  if (parts.some((p) => EXCLUDE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(base)) return true;
  if (base.startsWith('.env.') && base !== '.env.example') return true;
  if (EXCLUDE_EXT.has(path.extname(base).toLowerCase())) return true;
  // 显式排除 data/out 运行期缓存
  if (rel.startsWith('data/out/') || rel.startsWith('data\\out\\')) return true;
  return false;
}

function isBinary(buf) {
  if (buf.includes(0)) return true;
  // round-trip 校验：含 U+FFFD 字符的合法 UTF-8 文本（例如文档里引用了乱码样例）
  // 仍应按文本上传，不能因为出现了替换字符就把整个 md 当二进制 base64 塞进仓库。
  return !Buffer.from(buf.toString('utf8'), 'utf8').equals(buf);
}

function collectFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    if (shouldExclude(rel)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...collectFiles(full, rel));
    else if (e.isFile()) out.push(rel);
  }
  return out.sort();
}

// ─────────────────────────── Token ───────────────────────────
function resolveToken() {
  const fromArg = arg('--token', null);
  if (fromArg) return fromArg;
  for (const k of ['GITHUB_TOKEN', 'GH_TOKEN']) if (process.env[k]) return process.env[k];
  const f = path.join(os.homedir(), '.evalhub_github_token');
  if (fs.existsSync(f)) {
    const t = fs.readFileSync(f, 'utf8').trim();
    if (t) return t;
  }
  const cred = path.join(os.homedir(), '.git-credentials');
  if (fs.existsSync(cred)) {
    const line = fs.readFileSync(cred, 'utf8').split('\n').find((l) => l.includes('github.com'));
    if (line) {
      try { return decodeURIComponent(new URL(line.trim()).password); } catch { /* ignore */ }
    }
  }
  return null;
}

// ─────────────────────────── HTTP ───────────────────────────
async function gh(pathname, { method = 'GET', body = null, token = null } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'evalhub-push/1.0',
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== null) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${API}${pathname}`, {
    method,
    headers,
    ...(body !== null ? { body: JSON.stringify(body) } : {}),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' ? (data.message || JSON.stringify(data)) : String(data).slice(0, 200);
    const e = new Error(`GitHub API ${method} ${pathname} → HTTP ${res.status}: ${msg}`);
    e.status = res.status;
    throw e;
  }
  return data;
}

// ─────────────────────────── 主流程 ───────────────────────────
async function main() {
  const token = resolveToken();
  const files = collectFiles(ROOT);
  let total = 0;
  const entries = [];
  const binaries = [];

  for (const rel of files) {
    const buf = fs.readFileSync(path.join(ROOT, rel));
    total += buf.length;
    if (isBinary(buf)) {
      binaries.push({ path: rel, content: buf.toString('base64') });
      continue;
    }
    const content = buf.toString('utf8');
    for (const re of SECRET_PATTERNS) {
      if (re.test(content)) {
        // 只报告文件，不打印命中的内容
        throw new Error(`文件 ${rel} 命中密钥模式，已中止。请检查后加入 .gitignore。`);
      }
    }
    entries.push({ path: rel, mode: '100644', type: 'blob', content });
  }

  console.log(`仓库：${REPO}  分支：${BRANCH}`);
  console.log(`待提交文件：${entries.length} 个文本 + ${binaries.length} 个二进制 = ${files.length} 个，共 ${(total / 1024).toFixed(0)} KiB`);
  console.log(`Token：${token ? '已获取（来源已隐藏）' : '未提供'}`);
  console.log(`模式：${DO_IT ? '真正推送' : 'DRY-RUN（不写入）'}`);
  console.log('\n顶层目录分布：');
  const byTop = {};
  for (const f of files) {
    const t = f.includes('/') ? f.split('/')[0] : '(root)';
    byTop[t] = (byTop[t] ?? 0) + 1;
  }
  for (const [k, v] of Object.entries(byTop).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(16)} ${v}`);

  // 无 token 也能做的只读检查
  let repoInfo;
  try {
    repoInfo = await gh(`/repos/${REPO}`);
    console.log(`\n远端仓库：${repoInfo.full_name} | 默认分支 ${repoInfo.default_branch} | 当前 HEAD 更新于 ${repoInfo.pushed_at}`);
  } catch (e) {
    console.warn(`\n无法读取远端仓库（不影响 dry-run）：${e.message}`);
  }

  if (!DO_IT) {
    console.log('\nDRY-RUN 完成。确认无误后执行：');
    console.log('  node tools/push_to_github.mjs --yes');
    console.log('\n若尚未配置 token，把 PAT 写入 ~/.evalhub_github_token（单行，无换行），不要贴到对话里。');
    return;
  }

  if (!token) throw new Error('缺少 GitHub Token：请写 ~/.evalhub_github_token 或设 GITHUB_TOKEN');

  const who = await gh('/user', { token });
  console.log(`\n认证身份：${who.login}`);

  // 1) base commit
  const ref = await gh(`/repos/${REPO}/git/ref/heads/${BRANCH}`, { token });
  const baseCommitSha = ref.object.sha;
  const baseCommit = await gh(`/repos/${REPO}/git/commits/${baseCommitSha}`, { token });
  console.log(`基准 commit：${baseCommitSha.slice(0, 10)}（${baseCommit.message.split('\n')[0].slice(0, 50)}）`);

  // 回滚安全网：这次是覆盖式的大版本更新，先把旧 HEAD 固定成 tag。
  // 已存在则跳过（重复推送不会产生第二个 tag）。
  try {
    await gh(`/repos/${REPO}/git/refs`, {
      method: 'POST', token,
      body: { ref: 'refs/tags/v1-archive', sha: baseCommitSha },
    });
    console.log(`已创建回滚锚点：tag v1-archive → ${baseCommitSha.slice(0, 10)}`);
  } catch (e) {
    if (e.status === 422) console.log('回滚锚点 v1-archive 已存在，跳过');
    else throw e;
  }

  // 2) 二进制文件先建 blob，换成 sha 引用
  for (const b of binaries) {
    const blob = await gh(`/repos/${REPO}/git/blobs`, {
      method: 'POST', token,
      body: { content: b.content, encoding: 'base64' },
    });
    entries.push({ path: b.path, mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 3) 一次 tree 提交全部文本文件
  console.log(`创建 tree（${entries.length} 个条目）…`);
  const tree = await gh(`/repos/${REPO}/git/trees`, {
    method: 'POST', token,
    body: { base_tree: baseCommit.tree.sha, tree: entries },
  });

  // 4) commit
  const commit = await gh(`/repos/${REPO}/git/commits`, {
    method: 'POST', token,
    body: { message: MESSAGE, tree: tree.sha, parents: [baseCommitSha] },
  });

  // 5) 移动分支指针
  await gh(`/repos/${REPO}/git/refs/heads/${BRANCH}`, {
    method: 'PATCH', token,
    body: { sha: commit.sha, force: false },
  });

  console.log(`\n✅ 推送成功：${commit.sha}`);
  console.log(`   https://github.com/${REPO}/commit/${commit.sha}`);
  console.log(`   ${files.length} 个文件，单个 commit`);
}

main().catch((e) => {
  console.error('\n失败：', e.message);
  process.exit(1);
});
