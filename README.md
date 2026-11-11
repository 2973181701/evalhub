# EvalOps · 企业级 LLM 评测与标注平台

> 从一个「能跑通的评测脚本」升级为**可部署、可并发、可审计、可复现**的评测平台。
> 核心问题不是「怎么调一个模型 API」，而是：**凭什么相信一个评分器的结果？**
>
> v1（[历史 README](docs/README_v1.md)）：MoonBit 纯函数引擎 + JSON 文件 + 单体页面。
> **v2（当前）**：PostgreSQL 版本化数据层、异步评测队列、多实例安全领取、RBAC、
> LLM-as-Judge 一致性实验、模型对比、盲标队列与留出集评估。

---

## 实测状态

| 项 | 结果 |
|---|---|
| 接口验收 | **43 / 43 通过**（含一次真实大模型调用） |
| 单元测试 | **22 / 22**（规则层 12 + 统计层 10） |
| MoonBit 引擎 | **75 / 75** |
| 前端构建 | Vue 3 + Vite，126.12 kB（gzip 46.77） |
| 基线评测 | glm-4-flash，20/20 有效，总分 **3.88**，p50 **4.2s** / p90 **14.2s** |
| 重测稳定性 | 同配置两次独立运行，总分 3.86 → 3.88（**Δ +0.02，<1%**） |
| 多实例队列 | 双实例并发 6 个任务，**零重复执行** |
| Judge 一致性 | 提示词迭代使 Cohen's κ **0.3204 → 0.6341**（一致率 65% → 85%） |
| 标注队列 | 120 组 A/B，8 种失败模式，36 条留出集，零跨题泄漏 |
| 部署 | 提供 `deploy/bootstrap.sh` 一键脚本（Ubuntu 24.04 + PG + nginx + pm2），已在公网实测；v2 需重新上传部署包 |

所有数字来自真实运行，可用仓库内脚本复算；没有占位符或估算值。

---

## 一、解决了什么

大多数「LLM 评测项目」停在一张平均分表。企业真正卡住的是四件事：

1. **结果不可复现** —— 数据集改了但版本号没变，上周的分数这周对不上。
2. **评测阻塞界面** —— 20 条同步跑，页面转圈，中途关掉就全丢。
3. **没法证明评分器可信** —— 换了个「更聪明」的评委，凭什么说它比规则打分好？
4. **上线后没人敢用** —— 没有鉴权、没有审计、没有成本核算，写接口谁都能调。

v2 逐条对应：数据集不可变版本 + `config_hash`；异步队列 + 行锁领取；
Cohen's κ 量化 Judge 与人工的一致性；JWT 三角色 + 审计日志。

---

## 二、架构

```
Vue 3 前端（6 个页面 + 登录）
        │  /api 反向代理
        ▼
Express 网关  ── JWT / RBAC / 审计
        │
        ├── repo/  ── PostgreSQL 17（主） 或 JSON（回退，接口完全一致）
        ├── jobs/  ── 异步评测队列（FOR UPDATE SKIP LOCKED）
        ├── judge/ ── LLM-as-Judge + 确定性规则前置
        ├── labeling/ ── 盲标队列 / 留出集 / κ 统计
        ├── compare.js ── 双 run 五维差异
        └── engine.js ── MoonBit 纯函数引擎（评分规则单点定义）
```

**关键约定**：评分规则只在 MoonBit 引擎里定义一次，网关层不做业务计算；
数据集一经导入不可修改，改内容就新增 version；所有 run 记录 `config_hash`。

---

## 三、快速开始

### 方式 A：Docker（推荐）

```bash
git clone https://github.com/2973181701/evalhub.git && cd evalhub
cp .env.example backend/.env        # 填 GLM_API_KEY（可选）
docker compose -f docker-compose.dev.yml up -d
psql "postgres://evalhub:evalhub@127.0.0.1:5433/evalhub" -f db/schema.sql
DATABASE_URL=postgres://evalhub:evalhub@127.0.0.1:5433/evalhub node db/migrate.mjs
node backend/server.js
```

### 方式 B：本地（免 Docker）

```bash
npm install && (cd frontend && npm install)
cd core && moon build --target js && cd ..   # 后端依赖编译产物
node backend/server.js                       # JSON 模式，无需数据库
(cd frontend && npm run dev)                 # http://localhost:5173
```

> `moon test` **不会**产出 `core/_build/.../src.js`，必须单独 `moon build --target js`，
> 否则后端启动即退出并提示找不到引擎产物（这个坑在 v1 文档里记过）。

### 方式 C：服务器

见 `deploy/bootstrap.sh`（2G swap → PG/nginx/node → 建库迁移 → pm2 → 前端构建 → nginx 配置）
与 `deploy/nginx-evalhub.conf`。后端默认只监听 `127.0.0.1`，公网入口只留 nginx。

---

## 四、核心能力

| 模块 | 说明 |
|---|---|
| **数据层** | 9 表 + 迁移，数据集不可变版本化，`eval_runs.config_hash` 保证可复现；迁移事务化、幂等、支持 `--dry-run` |
| **评测队列** | `POST /api/runs` 提交即返回，轮询进度，可取消；`FOR UPDATE SKIP LOCKED` 保证多副本不重复跑；重启后 stale 任务标 failed |
| **鉴权** | Node 内置 crypto 自签 HMAC-SHA256 + scrypt 口令，三角色 RBAC；默认关闭以便本地演示 |
| **模型对比** | 只在两次都跑过的题上比，数据集版本不同直接判不可比，差值方向固定 B−A |
| **LLM-as-Judge** | 五维打分 + A/B 偏好判定，严格 JSON、版本化缓存、5xx/429 分类重试；返回两两 Cohen κ 与三方 Fleiss κ |
| **盲标队列** | 120 组 A/B、8 种失败模式、位置随机化、按题目切分留出集；界面屏蔽设计意图与分组 |
| **指标注册中心** | Rubric 不可变版本化、自定义维度与权重、质量门禁（不达标自动阻断）；口径统一正是「中台」与「工具」的分界 |
| **报告** | 五维均值、按题型归因、P50/P90 延迟、失败条目、Markdown 导出 |

---

## 四之二、指标注册中心与质量门禁

评测维度和阈值不再写死在代码里，而是注册成**不可变版本**的口径（改口径 = 新增 version，
旧版本永久保留，可随时切回）。这正是「指标口径统一」——同一份分数在不同口径下结论可复算。

```bash
npm run rubric:seed        # 注册默认五维口径（幂等）
```

```
GET  /api/rubrics                     列出所有口径与版本
GET  /api/rubrics/:key                当前 active 口径
POST /api/rubrics                     注册新版本（admin）
POST /api/rubrics/gate                质量门禁（evaluator）
POST /api/rubrics/:key/activate       切回历史版本（admin）
```

门禁是无状态计算，不落库，可直接接进 CI：

```bash
curl -X POST localhost:3000/api/rubrics/gate -H 'Content-Type: application/json'   -d '{"key":"evalhub-core","scores":[{"total":3.88,"accuracy":2.92,"safety":4.97}]}'
# → {"pass":true,...} 或 {"pass":false,"reasons":["维度 safety 均值 3.35 < 门槛 4"]}
```

校验规则在注册时强制执行：维度权重和必须为 1、门槛不得越界、未知维度拒绝；
`content_hash` 相同的内容不重复建版本。门禁计算是纯函数，38 项单测覆盖压线边界、
维度独立门槛、低分样本占比与空样本拒绝。

---

## 五、评测方法：Judge 到底可不可信

完整实验见 [`reports/judge_prompt_experiment.md`](reports/judge_prompt_experiment.md)。

让三个「评分者」对同一批 20 组 A/B 做偏好判定：人工标注（金标准）、规则判优、LLM-as-Judge。

| 配置 | 一致率 | Cohen κ | 95% CI |
|---|---:|---:|---|
| v2 规则优先 | 65.0% | 0.3204 | [-0.060, 0.663] |
| v3 +4 个 few-shot | 55.0% | 0.2742 | [0.009, 0.561] |
| **v4 +隐式形态约束** | **85.0%** | **0.6341** | [0.219, 1.0] |
| v5 +先自解 | 80.0% | 0.5122 | [-0.035, 0.885] |
| v6 两步调用（决策表） | 55.0% | 0.2742 | [0.043, 0.554] |
| **hybrid 规则前置** | **85.0%** | **0.6341** | [0.219, 1.0] |

三个值得记住的结论：

1. **加 few-shot 反而变差。** 模型把「短答案该赢」学成了「只有明文约束才算约束」，
   于是把「中国的首都是哪个城市？」判成平手。有效改动是**把人类真正在用的规则写出来**
   （题目要求的输出形态本身就是约束），不是多给例子。
2. **规则越多，弱模型越逃向「平手」。** v6 有 5 种情形，平手率涨到 50%–65%；
   它甚至在 A 4 字 / B 315 字时写「形态详略相当」。v4 最好，恰恰因为只有一条主线。
3. **可计算的事不该问模型。** v4 曾在两个**逐字节相同**的答案之间编造出「A 更简洁」。
   改成代码守卫后，单条修复就让 κ 从 0.4667 升到 0.6341；hybrid 进一步把
   枚举标签题与明确字数上限交给确定性规则，20% 判定不再依赖模型。

> ⚠️ 上述 κ 均为 **in-sample**（提示词就是照这 20 条的错误改出来的），且 n=20、
> B / 平手各仅 2 条，CI 很宽。可信数字需要留出集 —— 流水线已就绪，
> 见 [`reports/label_pipeline.md`](reports/label_pipeline.md)。

---

## 六、数据飞轮（v2 新增）

```
评测任务产生回答 → 生成 A/B 对 → 盲标队列（人）→ 留出集 κ 复评
                                      ↓
                          导出 DPO/SFT → 微调 → 再评测
```

- 40 道新题 × 3 = **120 组 A/B**，覆盖 8 种失败模式；设计意图 A54/B36/平手30，接近均衡
- 位置按哈希随机化（平均长度 A 64 / B 72 字），消除位置偏差
- 按**题目**哈希切分：train 84 / **test 36**，同题所有变体同侧，零泄漏
- 三条防线：盲标字段白名单、标签来源不可伪造（`label_source` 服务端决定）、
  test 集无真人标签时**拒绝输出 κ**

```bash
npm run label:build -- --batch queue-v1   # 生成
# 打开 #labelqueue 逐条人工标注
npm run label:heldout                     # 出留出集报告
```

---

## 六之二、数据中台：血缘与质量

「怎么评」由评测中台回答，「凭什么信这些数据」由这一层回答。两件事：**血缘**（数据从哪来）与**质量**（数据干不干净）。

**血缘**：`lineage_edges` 是从现有表关系**派生**的边，不是第二份真相源，任何时候都能 `rebuild` 重建；
`lineage_events` 登记无法推导的跨系统事件（外部题库接入、报告导出），重建时不清理。
支持上游/下游递归追溯，带环保护。

```
GET  /api/lineage/graph                         全图 + 已知缺口
GET  /api/lineage/walk?type=&id=&direction=    上游 / 下游追溯
POST /api/lineage/rebuild                      重建派生边（幂等）
```

实测：1 个数据集版本 + 1 次 local 评测 + 20 条结果 + 标注批次 → **9 节点 / 7 边 / 7 种关系**；
从 `dataset:evalhub-core@v1` 下游可达 run、标注集、报告、结果集（深度 2）。

**诚实缺口**（接口会直接返回，不假装全链路可追）：`eval_runs` 未记录使用的 rubric 版本，
所以「这次评测用了哪个口径」目前追不到；`label_pairs` 与 `datasets` 无外键。

**质量**：14 条规则注册在 `dq_rules` 表里（12 critical + 2 warning），覆盖唯一性、引用完整性、
枚举、进度边界、留出集泄漏、口径权重和、新鲜度。规则 SQL 只由服务端 seed，HTTP 不接受自定义 SQL，
且执行前强制校验为只读 SELECT。

```
GET  /api/dq/rules     POST /api/dq/run     GET /api/dq/report     GET /api/dq/history
npm run governance:seed   # 注册规则 + 登记事件 + 重建血缘 + 跑一次检查
```

实测：12 条 critical 全过，**质量分 100**；2 条 warning 是真实提示（留出集尚无真人标签、近 7 天无新 run）。
**反向验证**：故意把某次 run 的 `done_items` 改成 999 → 立即被 `run_progress_bounds` 抓到，
分数降到 91.67 / status=critical；恢复后回到 100。规则不是摆设。

前端「数据治理」页可查看质量分、规则清单、血缘上下游追溯与已知缺口。

---

## 七、诚实边界

- **Judge 尚未达到可替代人工的水平**：κ 0.6341 刚过常用门槛 0.6，但 CI 宽、样本小。
- **留出集标签仍需人工标注**，仓库里不含任何伪造标签；测试夹具一律标记并被排除。
- **训练层（QLoRA / SFT）尚未实现** —— 本项目目前是评测与数据层，不是模型训练平台。
- **token 计量未接真实计费**，`tokens_in/out` 为 null，成本字段不可对外承诺。
- **进程内队列在 PG 模式下已改为数据库领取**；若用 JSON 模式仍为进程内队列，多副本会重复执行。
- 题目与生成答案来自自建题库与确定性模板，**不是真实业务语料**。

---

## 八、目录

```
backend/
  repo/          仓储选择器 + PG/JSON 双实现
  labeling/      盲标队列（service / repository / stats）
  jobs/runs.js   异步评测队列
  judge.js       LLM-as-Judge（提示词版本可切换）
  judge_rules.js 确定性判优规则
  auth.js users.js compare.js env.js db.js
core/            MoonBit 纯函数引擎（75 单测）
db/              schema.sql / migrate.mjs / migrations/003_label_queue.sql
tools/           api_verify / baseline_report / judge_experiment / 生成器 / 评估器
test/            22 项单元测试
reports/         基线报告、Judge 实验、数据飞轮说明
deploy/          bootstrap.sh / nginx 配置 / 打包脚本
docs/            v1 README 归档与踩坑记录
```

## 九、复现命令

```bash
npm test                                  # 22 项单测
node tools/api_verify.mjs                 # 43 项接口验收
JUDGE_PROMPT=v4 node tools/judge_experiment.mjs
JUDGE_MODE=hybrid node tools/judge_experiment.mjs
node tools/baseline_report.mjs --provider glm
```

## License

MIT · 详见 [LICENSE](LICENSE)
