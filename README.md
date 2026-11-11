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
| **服务化** | API Key（哈希存储 / 绑租户+角色 / 可撤销）+ 零依赖 SDK + CI 质量门禁（退出码区分不达标与回退） |
| **多租户隔离** | 业务线级数据隔离 + 每业务线角色；基线共享、工作区私有；越权实测 404/403 |
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

## 六之三、口径血缘、数据接入与资产目录

**口径血缘（补齐上一轮的已知缺口）**：`eval_runs` 新增 `rubric_key` / `rubric_version`，
创建任务时自动记录当时生效的口径；血缘重建后生成 `rubric → run` 的 `scored_by` 边。
口径版本也进入 `config_hash`，因此「同参数不同口径」不会被当成可复现重跑；
模型对比时若两次 run 口径不同，直接判 `not_comparable`。历史 run 保持 NULL，**不伪造回填**，
对比时以 `caveat` 标注而不阻断。

**数据接入**：`tools/ingest_dataset.mjs` 把 JSON/CSV 评测集接成**不可变数据集版本**：

```bash
npm run ingest:dataset -- --file data/inbox/sample_prompts.json --name demo-01 --dry-run
npm run ingest:dataset -- --file data/inbox/sample_prompts.json --name demo-01
npm run ingest:dataset -- --list
npm run ingest:dataset -- --rejects demo-01
```

- schema 校验：id 格式与唯一性、题型白名单、prompt 非空与长度上限
- `content_hash` 去重：同内容只建一次版本，重跑返回 `skipped`
- 拒绝行留原因与原始 payload，不静默丢弃；批次与血缘事件一并落库
- 样例数据全部标注 **`synthetic`**，不是真实业务数据，报告中明确写出来源

实测：8 行样例 → 接受 6 / 拒绝 2（重复 id、白名单外题型），产出 `ingested@v1`；
换批次名重跑同内容 → `skipped`；HTTP 接入另一批 1 条 → `ingested@v2`。

**资产目录**：`v_asset_catalog` 是派生视图，把数据集 / 口径 / 标注批次 / 评测任务 /
接入批次统一成可检索资产（不存第二份真相源）。

```
GET /api/catalog?type=&q=&limit=      GET /api/catalog/summary
POST /api/ingest/dataset              GET /api/ingest/batches
GET /api/ingest/batches/:name/rejects
```

实测目录 5 类资产；全文检索 `ingest` 命中数据集与接入批次。前端「数据治理」页可直接查看。

---

## 六之四、多租户隔离（业务线 / 项目空间）

平台不是给一个团队用的。多个业务线共用一套评测能力时，必须回答「数据怎么隔离」，
否则第一次安全评审就会被卡住。

**模型：全局基线 + 租户工作区**

| 资产 | 归属 | 理由 |
|---|---|---|
| 基线数据集 `evalhub-core` | 全局（`tenant_id IS NULL`，只读） | 复制到每个租户会产生多个版本号，跨租户比较时无法判断差异来自模型还是数据，正好破坏「可复现」这个前提 |
| 业务线接入的数据集 | 租户私有 | 各业务线自己的题库互不可见 |
| 评测口径（rubric） | 租户私有，各自版本线 | 新建业务线时自动复制默认空间的 active 口径作为 v1，开箱可用；之后各自演进 |
| 评测任务 / 标注队列 / 接入批次 | 租户私有 | 任务、标注题、接入记录互不越界 |
| 血缘图 / 质量巡检 | 平台级只读 | 治理动作跨租户，仅 `platform` 可访问；**不做半吊子过滤**，见下 |

**隔离实现**

- `tenant_id` 落到 8 张表；`datasets` / `rubrics` / `label_batches` / `ingestion_batches` 的
  唯一约束改为**按租户**（部分唯一索引处理 `tenant_id IS NULL` 的全局资产）。
- 租户上下文走 `AsyncLocalStorage`，`tenantId()` **没有上下文直接抛错**（fail-closed）。
  这么设计是因为 SQL 分散在 5 个模块里，逐个改签名必漏，而漏掉的那一处就是跨租户泄漏。
- 后台评测任务不在 HTTP 请求里，领取任务后按 `run.tenant_id` 显式建立上下文；
  拿不到租户就拒绝执行，不会用别的业务线的数据继续跑。
- **权限是「业务线内」的**：`user_tenants.role` 覆盖 `users.role`。同一个人可以在 A 业务线是
  admin、在 B 业务线只是 viewer；令牌里的 role 也是租户内角色。
- 切换业务线用 `X-Tenant: <slug>`，**必须是对应业务线成员**，否则 403；
  管理员权限不能跨业务线使用。

**实测（两个业务线交叉访问）**

| 检查 | 结果 |
|---|---|
| A 业务线读 B 业务线的任务 | **404**（不返回 403，避免泄漏「这个 id 存在」） |
| A 业务线用户 `X-Tenant: B` | **403** 你不是该业务线成员 |
| 任务列表 / 标注队列 / 接入批次 | 各 0 条 / 各 120 条、互不可见；同名数据集各自 `v1` |
| 口径版本线 | platform `[v1,v2] active v1`、risk-dept `[v1,v2] active v2`，互不影响 |
| 任务记录的口径 | risk-dept 任务记 `v2`、platform 记 `v1`（**修复了一个真实越界 bug**，见下） |
| 跨租户标注 | **404** 未找到样本 |
| 跨租户对比 | **404** 任务不存在 |
| 治理接口（血缘/质量） | 非 platform **403** |

**过程中修掉的两个真问题**

1. `resolveActiveRubric()` 查 active 口径时**没带租户条件**，取到「全库第一条 active」，
   把 platform 的 v1 记到了 risk-dept 的任务上。租户化改造的价值就在这里：
   这类错误在单租户下永远不会暴露。
2. `/api/tenants` 不经过 `requireRole`，`req.user` 从未被赋值，表现是「登录了但列表空」。
   改为租户中间件在令牌有效时注入身份。

**边界（没做的，别当成有）**

- 没有 SSO / 组织架构同步：成员靠 `tools/tenant.mjs --add-member` 或接口添加
- 没有租户配额、计费分摊、租户删除与数据导出
- 基线数据集共享，因此**基线题目的标注也共享**；业务线自定义题库才是隔离的
- 治理层限定 platform 而非按租户过滤：血缘边是从表关系派生的，没有租户字段，
  按前缀猜租户会变成「看起来隔离、其实漏了」，比不隔离更危险

```bash
npm run tenant:list
npm run tenant:create -- --create risk-dept --name "风控业务线"
npm run tenant:member -- --add-member risk-dept --email someone@x.com --role evaluator
```

---

## 六之五、服务化：API Key、SDK 与 CI 门禁

一个平台有没有被真正使用，看的是**别的系统有没有接进来**。JWT 是给人用的、8 小时过期，
CI 里没法用；所以补了机器对机器的长期凭据，以及配套的 SDK 和门禁脚本。

**API Key（`ehk_<8位标识>.<secret>`）**

| 设计 | 原因 |
|---|---|
| 库里只存 `sha256(明文)` | 库被拖走也拿不到可用密钥；不提供「查看密钥」接口 |
| 明文只在创建时返回一次 | 和主流云厂商一致，避免「随手存明文」的团队习惯 |
| 绑定**业务线 + 角色** | 一把 key 只能在一个业务线内动作，不会变成全平台万能钥匙 |
| 只支持撤销（留时间戳） | 撤销即时生效；`last_used_at` 用来识别僵尸密钥 |
| 校验失败统一一条错误 | 不区分「不存在 / 已撤销 / secret 错」，避免探测 |

```
GET    /api/api-keys       列出本业务线密钥（只有前缀，不含 secret）
POST   /api/api-keys       创建（返回明文一次）
DELETE /api/api-keys/:id   撤销
```

实测：`source=api-key` 被正确识别；`evaluator` 密钥注册口径 **403**；
拿 platform 的密钥带 `X-Tenant: risk-dept` **403**；撤销后同一密钥立刻 **401**。

**生命周期：到期与轮换**

| 能力 | 实现 | 为什么这样做 |
|---|---|---|
| 到期 | `expires_at`，到期那一刻即失效 | 「下次清理时失效」会让密钥多活一个清理周期 |
| 轮换 | `POST /api/api-keys/:id/rotate`，旧密钥改名 `name@retired-<id>` 并进入宽限期 | 直接撤销再建新的，调用方在「拿新密钥 → 改配置 → 重新部署」之间必然断流 |
| 传承 | `rotated_from` 指向旧密钥 | 审计时能追一条密钥的传承链，而不是看到一串孤立记录 |
| 状态 | `active` / `revoked` / `expired` 三态 | 「已过期」和「已撤销」处理方式不同，混在一起会让运维误判 |

实测：轮换后新旧密钥**同时可用**；`--grace 0` 时旧密钥立刻 401、新密钥立刻 200；
到期时间设在过去的密钥创建后直接 401，列表显示「已过期」。

**限流：按 key、多副本安全**

```
api_key_usage(key_id, window_start, count)   -- 固定窗口（按分钟）+ UPSERT 自增
```

- 计数放数据库而不是进程内存：多副本部署时内存计数各算各的，等于「额度 × 副本数」。
- **先计数再判断**，被拒绝的请求也占一次额度——否则被限流的客户端可以无限重试而不消耗额度。
- 响应带 `X-RateLimit-Limit / Remaining / Used`，超限返回 **429 + Retry-After**。
- 计数保留 2 天，服务每小时清理一次。

实测（配额 3/min）：前 3 次 200，第 4、5 次 429 且 `Retry-After: 40`；
正常请求返回 `X-RateLimit-Limit: 60 / Remaining: 59`。

**SDK（Node 与 Python，均零依赖）**

Python 版用标准库 `urllib`，因为训练侧、数据侧、DocGuard 业务线都是 Python：

```python
from evalhub_client import EvalHubClient

client = EvalHubClient(base_url="http://127.0.0.1:3000", api_key=os.environ["EVALHUB_API_KEY"])
run = client.create_run(provider="glm")
client.wait_run(run["id"])
print(client.aggregate(run["id"])["total"])
```

两个 SDK 的行为约定一致：`wait_run` 只在 queued/running 时轮询、`aggregate` 只统计有分数的行、
`results` 拆掉 `{count, rows}` 信封。实测 Python 端 3 题跑通、总分 4.067 与 Node 端逐位一致。

**SDK（`sdk/evalhub-client.mjs`，零依赖）**

```js
import { EvalHubClient } from './sdk/evalhub-client.mjs';

const client = new EvalHubClient({
  baseUrl: 'https://eval.example.com',
  apiKey: process.env.EVALHUB_API_KEY,
});

const { run, aggregate } = await client.runAndAggregate({ provider: 'glm' });
console.log(run.id, aggregate.total, aggregate.dims);
```

除了薄封装，还做了三件调用方一定会踩的事：`waitRun` 只在 queued/running 时轮询、
`aggregate` **只统计有分数的行**（把失败条目当 0 会稀释成假低分）、
`results` 把 `{count, rows}` 信封归一化成数组。

**CI 门禁（`tools/gate_check.mjs`）**

```bash
EVALHUB_API_KEY=ehk_xxx node tools/gate_check.mjs   --base https://eval.example.com --provider glm   --rubric evalhub-core --baseline latest --max-regress 0.05
```

| 退出码 | 含义 | 处置 |
|---:|---|---|
| 0 | 通过 | 放行 |
| 2 | 低于口径阈值 | 说明这次改动本身不达标 |
| 3 | 相对基线回退超限 | 说明是本次改动引入的退化，定位范围小 |
| 1 | 执行错误 / 样本不足 | 不算通过，也不算失败，要人看 |

两者分开是因为**处置不同**：不达标是「就是差」，回退是「本来能过，现在不如上次」。

**两个必须校准的地方**

1. **样本量**：3 条里 1 条低分就是 33% 失败率，会直接越过 rubric 的失败率上限，
   把噪声判成退化。所以门禁默认 `--min-samples 10`，不足就**拒绝出结论**而不是硬判。
2. **阈值必须对着基线校准**：默认口径 v2 设了 `max_fail_rate 25%`，
   但基线实测是 **35%**（20 题里 7 题低于 3.5 分）——这道门禁上线第一天就会拦下自己的基线，
   然后被团队关掉。已注册 v3 把上限放到 40%，并在描述里写明「等微调后收紧」。
   **门槛不是拍脑袋定的，是量出来的。**

示例流水线在 `.github/workflows/eval-gate.yml`（PR 改动 prompts / 模型配置时触发）。

**边界**

- 没有 IP 白名单、没有细粒度 scope（一个 key 的权限就是它的 role）；限流是固定窗口，不是滑动窗口/令牌桶，分钟边界会有 2 倍突刺
- 门禁只覆盖「单次评测 + 相对基线回退」，没有做多模型 A/B 的显著性检验
- `gate_check` 的基线对比用的是两侧总分均值，题集不同时不做交集处理（对比接口有做，门禁脚本没调）

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
