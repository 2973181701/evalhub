# 数据缺陷记录 · 标注队列含 `undefined` 占位符

- **发现时间**：2026-11-12
- **发现方式**：导出留出集标注清单后**逐条目视抽检**（第一条就看到 B 侧写着 `undefined`）
- **严重级别**：高 —— 直接使留出集不可用；且如果照原计划让标注员标完，会产出一个「好看但无意义」的 κ
- **影响数据**：`label_pairs` 批次 `queue-v1`，**105 / 120 组**（test 33/36，train 72/84）
- **影响范围**：仅标注队列。评测集 `data/prompts.json`（20 题）与训练集 `data/answers/*.json` 未受影响，
  已发布的模型分数（4.03 / 3.64）与约束门禁回测**均不依赖这批数据**

## 现象

生成出的 A/B 对里，有一侧是字符串字面量 `undefined`，另一侧是模板灌水文本。例：

```
L081 逻辑推理
A: 这个问题涉及多个方面，建议查阅相关资料或官方文档。……
B: undefined
```

## 根因

`tools/build_label_queue.mjs` 的答案算子读的是 `t.ref`，而题库 `data/prompts_extra.json`
的字段名是 **`reference`**。`String(undefined).trim()` 得到字符串 `"undefined"`，
于是 6 个算子全部产出占位符：

```js
const concise = (t) => String(t.ref).trim();        // ← t.ref 不存在
const verbose  = (t) => `${String(t.ref).trim()}。${FILLER}`;
```

只有 `offtopic()` 不依赖题目字段，所以它生成的文本是正常的——这也解释了为什么
每对里总有一侧"像话"、另一侧是 `undefined`。

## 为什么没被发现

三道防线全部失效，逐条记下来：

1. **没有输出校验**。脚本只校验了输入（`reference`/`distractor`/`task_type` 是否存在），
   没校验输出，`"undefined"` 是一个合法字符串，一路畅通无阻。
2. **统计指标掩盖了问题**。日志打印的是「平均长度 A/B：68/75」这类聚合值，
   `undefined` 正好 9 个字符，混在均值里看不出来。
3. **UI 盲标设计反而挡住了发现**。标注界面只显示 A/B 文本，不做「这看起来像坏数据」的提示；
   而队列有 120 条，人工逐条翻看才会撞见——本轮是导出成清单才看出来的。

## 修复

1. 字段名修正：`t.ref` → `t.reference`（6 处，用词边界正则替换，避免误伤已有的 `t.reference`）。
2. **加输出校验** `assertNoPlaceholder()`：任何 prompt / answer 为空或匹配
   `undefined|null|NaN` 即中止生成，打印前 10 条违规明细。宁可脚本炸，也不许占位符落库。
   （长度只要求非空——题库里「5」「甲」这种一字答案是合法内容，不替标注员判断题目好坏。）
3. 丢弃 `queue-v1`（当时 0 条标注，删除无损失），重新生成 `queue-v2`。

## 修复后

| | queue-v1（坏） | queue-v2（修复） |
|---|---:|---:|
| 含 `undefined` 的组数 | 105 / 120 | **0** |
| 平均长度 A / B | 68 / 75（被 9 字符的 `undefined` 稀释） | 见生成日志 |

## 对已发布结论的影响

**没有影响**，但这需要说清楚依据，而不是一句"没影响"：

- 已发布的模型分数来自 `data/answers/*.json`（本地模型真实输出）+ `data/prompts.json`（20 题），
  与 `label_pairs` 无交集；
- 约束门禁回测读的是同一批 answers，也不碰 label_pairs；
- Judge κ 0.6341 来自 `reports/judge_prompt_experiment.md` 的 20 组 A/B，那是 v1 遗留数据集，**不是** queue-v1。

## 一条教训

**「生成器有输入校验」不等于「产出是对的」。** 输入全合法、输出全是 `undefined` 这种事，
只有对**产出物本身的形态**做断言才能拦住；聚合统计拦不住，因为它把坏值平均掉了。
