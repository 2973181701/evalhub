# EvalHub · LLM 评测与标注一体化平台

> **状态：开发中（阶段 1 完成：MoonBit 5 维评测引擎 ✅）** —— 本 README 会在阶段 5 补全为完整版。

让「**评测发现模型问题 → 标注偏好数据 → 生成分析报告 → 导出 RLHF 训练数据**」形成闭环的 Web 平台。

## 评测引擎契约（阶段 1）

MoonBit 纯函数，JSON 进 JSON 出，Node 直接 `import`（`eval_engine`）：

```jsonc
// 输入
{ "prompt": "中国的首都是哪个城市？", "answer": "中国的首都是北京。", "reference": "北京", "task_type": "事实问答" }
// 输出（五维各 0–5 分，total 为五维均分）
{ "accuracy": 5, "completeness": 5, "logic": 2, "safety": 5, "expression": 3.5, "total": 4.1 }
```

评分是可解释的确定性规则：参考要点命中/覆盖率（准确性、完整性）、推导与代码结构标记词（逻辑性）、
敏感词与拒绝表态（安全性）、题型长度区间 + 结构标点 + 刷字惩罚（表达质量）。
非法输入返回 `{ "error": "invalid_json" }`，不向宿主抛错。规则细节见 `core/src/engine_eval.mbt`。

已知设计取舍：代码生成题取「全量要点 / 纯代码标识符」双口径较高者；创意写作的准确性与完整性给
中性分 3.0（规则引擎不判主观质量，交给标注员——这正是平台 RLHF 人工环节存在的意义）。

## 架构

```
Vue 3 前端（看板 / 标注 / 雷达图 / 导出）
        ↕ HTTP
Node.js 网关（调 GLM API + 加载 core 引擎）
        ↕ import（moon build --target js）
MoonBit 核心引擎（评测 / 标注 / 分析 / 数据 —— 纯函数，JSON in & out）
```

## 目录

| 目录 | 作用 |
|---|---|
| `core/` | MoonBit 核心引擎（本项目灵魂） |
| `backend/` | Node.js 网关（HTTP 接口 + 调大模型） |
| `frontend/` | Vue 3 + Vite 前端 |

## 快速开始（引擎侧）

**Windows 一键验收**：双击项目根目录的 `verify.bat`，会自动跑完下面 5 条命令并暂停显示结果。

手动方式（需先把 MoonBit 加入 PATH：`C:\Users\<你>\.moon\bin`）：

```bash
cd core
moon version            # 确认工具链
moon check              # 类型检查
moon test               # 单元测试（16 个，用例来自真实评测集 prompts.json）
moon run cmd/main       # 运行 CLI 自检 → 输出 "EvalHub core OK" + 引擎打分示例
moon build --target js  # 编译成 ESM JavaScript，供 Node 直接 import
```

回到仓库根目录，验证「Node import MoonBit 引擎」跨语言链路：

```bash
node tools/engine_smoke.mjs
```

## 借鉴声明

架构设计借鉴以下开源项目，代码为原创实现：

- [Label Studio](https://github.com/HumanSignal/label-studio) —— 标注平台工作流（项目 → 任务 → 标注 → 质检 → 导出）
- [Promptfoo](https://github.com/promptfoo/promptfoo) —— 声明式配置 + 可插拔断言引擎
- [EvalScope](https://github.com/modelscope/evalscope) —— Web 看板 + 报告可视化

## License

[MIT](./LICENSE)
