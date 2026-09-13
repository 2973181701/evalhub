# EvalHub · LLM 评测与标注一体化平台

> **状态：开发中（阶段 0 完成）** —— 本 README 会在阶段 5 补全为完整版。

让「**评测发现模型问题 → 标注偏好数据 → 生成分析报告 → 导出 RLHF 训练数据**」形成闭环的 Web 平台。

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
moon test               # 单元测试
moon run cmd/main       # 运行 CLI 自检 → 输出 "EvalHub core OK"
moon build --target js  # 编译成 ESM JavaScript，供 Node 直接 import
```

## 借鉴声明

架构设计借鉴以下开源项目，代码为原创实现：

- [Label Studio](https://github.com/HumanSignal/label-studio) —— 标注平台工作流（项目 → 任务 → 标注 → 质检 → 导出）
- [Promptfoo](https://github.com/promptfoo/promptfoo) —— 声明式配置 + 可插拔断言引擎
- [EvalScope](https://github.com/modelscope/evalscope) —— Web 看板 + 报告可视化

## License

[MIT](./LICENSE)
