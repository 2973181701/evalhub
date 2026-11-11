# training/ · Qwen3-1.7B 约束遵循微调

这一层回答的是评测平台回答不了的问题：**模型效果上不去时，下一步动哪里。**
之前所有工作都在「测」，这里开始「改」。

## 为什么是这个任务

基线评测暴露的具体短板（不是泛泛的「效果不好」）：

- glm-4-flash 在 20 题上总分 3.88，但**准确性 2.92**，摘要题 0.67、推理题 1.88
- 答案普遍比题目要求长一个数量级：问「首都是哪个城市」回 581 字
- 人工标注里 16/20 选的是**短答案**，因为题目本身有字数/格式约束

所以微调目标定得很窄：**学会按题目要求作答**（该给标签就给标签、该几个字就几个字）。
窄目标的好处是可以用 91 条样本验证方向对不对；坏处是它不代表通用能力提升，报告里必须写清楚。

## 流程

```bash
# 1. 构造训练集（GLM 蒸馏，40 题 × 3 候选 → 机器校验 → 91 条）
node training/build_sft_data.mjs --variants 3

# 2. 训练（单卡 8GB，fp16 LoRA；--load-in-4bit 可换 QLoRA）
python training/train_qlora.py --model D:/evalhub-train/models/Qwen3-1.7B --epochs 3

# 3. 生成回答（base 与微调后各一次）
python training/gen_answers.py --model ... --out data/answers/qwen_base.json
python training/gen_answers.py --model ... --adapter training/out/adapter --out data/answers/qwen_ft.json

# 4. 平台评分与对比（与 glm 走完全相同的评分路径）
curl -X POST localhost:3000/api/runs -d '{"provider":"file","config":{"answers":"qwen_base.json"}}'
curl -X POST localhost:3000/api/runs -d '{"provider":"file","config":{"answers":"qwen_ft.json"}}'
curl localhost:3000/api/runs/<ft>/compare/<base>
```

## 数据红线

| 项 | 做法 | 为什么 |
|---|---|---|
| 与评测集隔离 | 训练题来自 `data/prompts_extra.json`（40 题），评测用 `data/prompts.json`（20 题），**ID 与题干均无重叠**，脚本里做了硬校验，重叠直接终止 | 泄漏会让提升数字失去意义 |
| 来源标注 | 每条样本 `source=distilled:glm-4-flash`，manifest 里写明「GLM 生成，非人工标注」 | 蒸馏和人工标注在简历/报告里不能混为一谈 |
| 样本校验 | 按题型分别校验：标签题必须只给标签、字数题不得超限、事实/推理题必须落在参考要点上、代码题必须含代码；不过就丢 | 坏样本会被模型原样学走 |

当前数据：**91 条**，平均答案 15.9 字，字数约束零超限。
`情感分析` 6 题全部被丢弃——GLM 自己就没守住「只给标签」，这条本身就是可写进报告的发现。

## 环境

- GPU：RTX 4060 Laptop 8GB（torch 2.14.1+cu126，CUDA 12.6）
- 依赖装在 `D:/evalhub-train/venv`（独立 venv，不污染平台运行环境）
- 权重：ModelScope `Qwen/Qwen3-1.7B`（HF 直连不通，ModelScope 9.6MB/s）
- 不用 TRL：`SFTTrainer` 版本间 API 变动大，且默认会把 prompt 段也算进 loss。
  这里手写 label mask，只在 assistant 回复上计 loss。
