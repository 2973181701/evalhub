# 标注队列与留出集（数据飞轮）

> 目标：解决 `judge_prompt_experiment.md` 里那个无法靠调提示词解决的问题 ——
> **20 条同构样本 + 16:2:2 的类别分布，撑不起一个可信的 κ。**
> 本文描述已交付的数据扩增与留出集流水线，以及它刻意的边界。

## 一、为什么必须扩数据

v1 的 20 组 A/B 全部是 `(concise, verbose)` 一种策略组合，人工标签 A 16 / B 2 / 平手 2。
这带来两个问题：

1. **同构偏差**：评测的其实是「能不能识别啰嗦」，不是「能不能当好评委」。
   照这个模式扩到 100 条，κ 会虚高。
2. **κ 不稳定**：B 和平手各只有 2 条，任意一条翻转都能让 κ 变动 0.17；
   v4 的 95% CI 宽到 [0.219, 1.0]。

而且 v2→v6 的提示词全是照着这 20 条的错误改出来的，再做评估都属 **in-sample**。
可信数字只能来自一批**提示词设计过程从未看过**的留出集。

## 二、已交付的东西

| 文件 | 作用 |
|---|---|
| `data/prompts_extra.json` | 40 道新题，6 类题型，每题带 `reference`（正确要点）与 `distractor`（明确错误要点） |
| `db/migrations/003_label_queue.sql` | `label_batches` / `label_pairs` / `label_annotations` / 盲标视图 |
| `tools/build_label_queue.mjs` | 生成器：40 题 × 3 = 120 组待标注 A/B |
| `backend/labeling/queue-repo.js` | 纯 SQL，对外字段白名单 |
| `backend/labeling/queue.js` | 业务层：边界校验、标签来源防伪造 |
| `backend/labeling/stats.js` | κ / bootstrap / 意图一致率（纯函数，可单测） |
| `tools/eval_judge_heldout.mjs` | 只用 `split='test'` + `label_source='human'` 复算 κ |
| `frontend/src/views/LabelQueueView.vue` | 盲标界面（`#labelqueue`） |
| `test/*.test.mjs` | 22 项单元测试 |

接口：

```
GET  /api/label-queue?limit=&offset=&all=&task_type=   待标注列表（盲标字段）
GET  /api/label-queue/stats                            进度、来源、题型分布
POST /api/label-queue/:id/label                        提交标注（evaluator 门禁）
     { choice: 'A'|'B'|'平手', confidence?: 1-5, reason?: string }
```

## 三、数据设计：刻意打破同构

**8 种失败模式**（`concise_vs_verbose` 只是其中 1 种）：

| 策略 | 对比的是什么 | 设计意图 |
|---|---|---|
| `concise_vs_verbose` | 短答 vs 长篇冗余 | A（旧模式，保留约 1/8） |
| `correct_vs_fact_error` | 正确 vs 一处事实错 | A |
| `ontopic_vs_offtopic` | 切题 vs 答非所问 | A |
| `compliant_vs_violation` | 合规 vs 明显超字数 | A |
| `good_vs_good` | 两个措辞不同但都正确的回答 | **平手** |
| `bad_vs_bad` | 两个不同的错误回答 | **平手** |
| `direct_vs_hedging` | 直答 vs 反复自我推翻 | A |
| `code_only_vs_explained` | 纯代码 vs 代码+千字讲解（代码题） | A |

三处防偏差设计：

- **位置随机化**：A/B 顺序按 pair id 哈希决定，设计意图随之交换。
  实测平均长度 A 64 字 / B 72 字，不再「A 永远是短的那个」。
- **平手类占比 25%**：设计意图分布 A 54 / B 36 / 平手 30，接近均衡，
  不再出现「永远选 A 也能拿 80% 一致率」。
- **按题目切分留出集**：40 题按哈希排序取前 30%（12 题）为 `test`，
  同题的所有变体必落在同一侧 → **train 84 条 / test 36 条 / 零跨题泄漏**。

## 四、三条防线（这套东西最值钱的部分）

**1. 盲标**

队列接口只返回 `id / task_type / prompt / answer_a / answer_b / batch_id / created_at / labeled`。
`expected_choice`（设计意图）、`split`（分组）、`strategy_*`（策略名）、`reference` 一律不下发。

第二次迭代时我发现 `strategy_a/strategy_b` 被放进了视图 —— 标注者看到
「concise | verbose」就等于看到答案，已从视图删除。
SQL 层显式列白名单，**不用 `SELECT *`**，避免以后加列时不小心泄漏。

**2. 标签来源可追溯**

`label_annotations.label_source` 只允许 `human` / `test_fixture`。
HTTP 路由不接受客户端传的 `label_source`，服务端写死 `human`；
流程自检写入的模拟标签走 CLI 并标 `test_fixture`，评估脚本一律排除。

实测：客户端伪造 `"label_source":"test_fixture"` → 落库仍为 `human`；
写入 3 条 `test_fixture` 后跑评估 → 明确提示「还没有真人标签，不计算 κ」。

**3. 空数据不输出假结论**

`eval_judge_heldout.mjs` 在 test 集无真人标签时**直接退出**，不打印 κ。
样本数 < 10 时打印警告，声明结果只能作为过程观察。

端到端自检：临时写入 6 条模拟标签，脚本算出 κ = −0.5、CI [-1, 0]、并触发 `n<10` 警告 ——
标签是我乱填的，κ 为负恰好证明脚本读的是 `human` 字段而不是设计意图。
**这 6 条标签跑完立即删除，库已回到 0 标注。**

## 五、用法

```bash
# 1. 生成（已执行，批次 queue-v1，120 条）
DATABASE_URL=... npm run label:build -- --dry-run
DATABASE_URL=... npm run label:build -- --batch queue-v1

# 2. 人工标注：打开 http://localhost:5173/#labelqueue 逐条点
#    界面不显示策略、参考答案、分组，提交后自动跳下一条

# 3. 标完 test 集后出留出集报告
DATABASE_URL=... npm run label:heldout
# 可选：JUDGE_MODE=hybrid 用规则前置版复评
```

## 六、报告会额外给出什么

除了一致率、κ 和 bootstrap 95% CI，还会输出：

- **与设计意图的一致率**（难度诊断，不是正确率）：若 ≥ 95%，
  说明这批题一眼可判、人工几乎完全复现了生成时的设定，κ 会虚高，脚本会直接标红。
- **标签分布**：如果标完发现又是 A 占 80%，κ 依然不稳，需要回头补平衡样本。
- **分歧明细**：逐条列出人 / Judge 的选择与理由，供人工复核。

## 七、边界（必须说清楚）

- **我不能替你标注。** 这 120 条标签必须由真人在界面上点出来。
  生成器给的 `expected_choice` 只是设计意图，用它当标签等于自己给自己判卷。
- **题目是我新写的，不是你的业务数据。** 它能验证「Judge 的判断是否可泛化到没见过的题」，
  但不能替代真实业务分布。接真实语料时仍需按同一套切分/盲标流程重跑。
- **生成答案部分是模板派生的**（冗余段只加背景性废话，不含事实主张），
  真实感弱于线上模型输出。后续可把 `origin='eval_run'` 接进来：
  从 `eval_results` 取同一题的两次真实生成输出配成对，走同一套队列。
- **单人标注无法算标注者间一致性**。目前只能得到「Judge vs 单个人」的 κ；
  要评估标注质量本身，需要同一条样本由 2 人以上独立标注（`UNIQUE(pair_id, annotator_key)` 已支持）。
- **n 门槛**：test 集 36 条是上限。κ 的 CI 能否收窄到 ±0.15 量级，
  要看实际标满多少条以及三类标签是否均衡，我不会提前承诺。

## 八、下一步

1. **标满 36 条 test 集** → 出第一份 held-out κ，与 in-sample 的 0.6341 对比。
   这个差值本身就是「提示词迭代有没有过拟合」的直接证据。
2. **接 `eval_results` 真实输出**：把 `origin='eval_run'` 的 pair 混进队列，
   减少模板感，也让「评测任务 → 标注 → 回流训练集」这条飞轮真正闭合。
3. **回流训练集**：把已标注的低分样本导出成 DPO/SFT 格式（`/api/export` 已有能力），
   接到 Qwen3-4B QLoRA 微调，再用同一留出集复评 —— 这是简历里最完整的一段闭环。
