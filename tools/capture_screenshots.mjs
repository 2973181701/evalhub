#!/usr/bin/env node
/**
 * EvalHub · 页面截图脚本（用本机已装的 Edge/Chrome 无头模式，通过 CDP 驱动）
 *
 * 为什么不用 puppeteer：本机没有 Chromium 缓存，装一个要下几百 MB；
 * 而 Windows 自带 Edge，直接用 CDP（Chrome DevTools Protocol）驱动即可，零额外依赖。
 *
 * 做的事：
 *   1. 启动无头 Edge，开一个调试端口
 *   2. 通过 WebSocket 连 CDP，逐个页面导航 + 点击 + 截图
 *   3. 把截图写进 docs/screenshots/
 *
 * 运行（需要后端 3000 与前端 5173 都已启动）：
 *   node tools/capture_screenshots.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT_DIR = path.resolve(HERE, '..', 'docs', 'screenshots');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

const PORT = 9222;
const BASE = process.env.EVALHUB_FRONTEND || 'http://127.0.0.1:5173';

/**
 * ⚠️ 本脚本为了截出「标注提交后的引擎校验反馈」，会**真的调一次 POST /api/annotate**，
 * 那会写入运行期标注文件（data/out/annotations_submitted.json）。
 *
 * 这会永久改变项目状态：报告页的「平均置信度」会从 4.4 漂到 4.35、
 * 「运行期新增」从 0 变 1——**截图脚本污染了被截图的对象**，截图就和文档对不上了。
 *
 * 两道防线：
 *   1. 采集顺序：报告页（05/06/07）必须在提交标注**之前**截，否则截到的是被污染的状态
 *   2. 快照 / 还原：跑之前记下文件原样，跑完（含异常退出）写回
 */
const SUBMITTED = path.resolve(HERE, '..', 'data', 'out', 'annotations_submitted.json');
let submittedExisted = false;
let submittedSnapshot = null;

function snapshotSubmitted() {
  submittedExisted = fs.existsSync(SUBMITTED);
  if (submittedExisted) submittedSnapshot = fs.readFileSync(SUBMITTED, 'utf8');
}

function restoreSubmitted() {
  try {
    if (submittedExisted) {
      fs.writeFileSync(SUBMITTED, submittedSnapshot, 'utf8');
      console.log('  运行期标注文件已还原到截图之前的状态。');
    } else if (fs.existsSync(SUBMITTED)) {
      fs.unlinkSync(SUBMITTED);
      console.log('  运行期标注文件已删除（截图之前本来不存在）。');
    }
    console.log('  注意：后端是懒加载缓存，正在运行的后端仍持有旧数据；');
    console.log('        要让页面反映还原后的状态，请重启后端（本脚本不负责管理后端进程）。');
  } catch (e) {
    console.log('  ⚠ 还原运行期标注文件失败：' + e.message + '（请手动检查 ' + SUBMITTED + '）');
  }
}

function findBrowser() {
  for (const p of EDGE_CANDIDATES) {
    if (fs.existsSync(p)) return p;
  }
  throw new Error('找不到 Edge / Chrome 可执行文件，请手动设置浏览器路径');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 极简 CDP 客户端 */
class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', () => res());
      this.ws.addEventListener('error', (e) => rej(new Error('CDP WebSocket 连接失败：' + e.message)));
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
      } else if (msg.method) {
        this.events.push(msg.method);
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP 超时：${method}`));
        }
      }, 30000);
    });
  }

  /** 在页面里执行一段 JS，返回其值 */
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) throw new Error('页面内脚本抛错：' + JSON.stringify(r.exceptionDetails.text));
    return r.result?.value;
  }

  async goto(url, waitMs = 2200) {
    this.events = [];
    await this.send('Page.navigate', { url });
    // 等 load 事件（最多 8s），再额外等一点让 fetch 渲染完
    const deadline = Date.now() + 8000;
    while (!this.events.includes('Page.loadEventFired') && Date.now() < deadline) {
      await sleep(100);
    }
    await sleep(waitMs);
  }

  async screenshot(file) {
    const { data } = await this.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
    });
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    return fs.statSync(file).size;
  }
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = findBrowser();
  const profile = path.join(process.env.TEMP || '/tmp', 'evalhub-shot-profile');
  console.log('浏览器：' + browser);

  const proc = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--no-first-run',
      '--no-default-browser-check',
      `--remote-debugging-port=${PORT}`,
      `--user-data-dir=${profile}`,
      '--window-size=1680,1400',
      'about:blank',
    ],
    { stdio: 'ignore' },
  );

  // 等调试端口就绪
  let targets = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) {
        targets = page;
        break;
      }
    } catch {
      /* 端口还没起来，继续等 */
    }
  }
  if (!targets) {
    proc.kill();
    throw new Error('浏览器调试端口未就绪（9222）');
  }

  const cdp = new CDP(targets.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1680,
    height: 1400,
    deviceScaleFactor: 1,
    mobile: false,
  });

  snapshotSubmitted();
  const shots = [];

  // ① 评测看板：选一题 → 点「对已有真实回答打分」
  await cdp.goto(`${BASE}/#eval`);
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent.includes('对已有真实回答打分'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1500);
  shots.push(['01-eval-board.png', await cdp.screenshot(path.join(OUT_DIR, '01-eval-board.png'))]);

  // ② 评测看板：现调 GLM 生成回答再打分（真实大模型调用）
  await cdp.evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const b = btns.find((x) => x.textContent.includes('现调 GLM'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(9000); // 等大模型返回（实测约 3s，留足余量）
  shots.push(['02-eval-glm-live.png', await cdp.screenshot(path.join(OUT_DIR, '02-eval-glm-live.png'))]);

  // ③ 报告页：雷达图 + 均分表 + 一致性
  //    ⚠️ 必须排在「提交标注」之前——提交会写入运行期标注，把平均置信度从 4.4 改成 4.35
  await cdp.goto(`${BASE}/#report`, 2600);
  shots.push(['05-report.png', await cdp.screenshot(path.join(OUT_DIR, '05-report.png'))]);

  // ④ 报告页下半部分：滚动到一致性 + 导出区
  await cdp.evaluate('window.scrollTo(0, document.body.scrollHeight)');
  await sleep(900);
  shots.push(['06-report-consistency.png', await cdp.screenshot(path.join(OUT_DIR, '06-report-consistency.png'))]);

  // ⑤ 报告页：点导出，展示 RLHF 结果
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === '导出');
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1500);
  shots.push(['07-report-export.png', await cdp.screenshot(path.join(OUT_DIR, '07-report-export.png'))]);

  // ⑥ 标注界面：填一条完整标注（放在最后，因为它会写运行期状态）
  await cdp.goto(`${BASE}/#annotate`);
  await cdp.evaluate(`(() => {
    const pick = (t) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === t);
    const ab = document.querySelectorAll('.ab-card')[0];
    if (ab) ab.click();
    const setVal = (el, v) => {
      const setter = Object.getOwnPropertyDescriptor(el.constructor.prototype, 'value').set;
      setter.call(el, v);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    const ta = document.querySelector('textarea');
    if (ta) setVal(ta, '选 A：依据维度 5 表达质量——A 直接给出答案；B 铺陈大量背景介绍，信息冗余，同等信息量下简洁者优先。');
    const c4 = [...document.querySelectorAll('.conf-btn')].find((b) => b.textContent.trim() === '4');
    if (c4) c4.click();
    return true;
  })()`);
  await sleep(600);
  shots.push(['03-annotate.png', await cdp.screenshot(path.join(OUT_DIR, '03-annotate.png'))]);

  // ⑦ 标注界面：提交，展示引擎校验反馈
  await cdp.evaluate(`(() => {
    const b = [...document.querySelectorAll('button')].find((x) => x.textContent.includes('提交标注'));
    if (b) b.click();
    return Boolean(b);
  })()`);
  await sleep(1800);
  shots.push(['04-annotate-validated.png', await cdp.screenshot(path.join(OUT_DIR, '04-annotate-validated.png'))]);

  proc.kill();
  restoreSubmitted();
  console.log('\n截图已写入 ' + path.relative(path.resolve(HERE, '..'), OUT_DIR));
  for (const [name, size] of shots) console.log(`  ${name.padEnd(30)} ${(size / 1024).toFixed(1)} KB`);
}

main().catch((e) => {
  console.error('截图失败：' + e.message);
  process.exit(1);
});
