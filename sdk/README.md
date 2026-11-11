# EvalHub SDK（零依赖）

只依赖 Node 18+ 内置的 `fetch`，不引第三方包。

```js
import { EvalHubClient } from './evalhub-client.mjs';

const client = new EvalHubClient({
  baseUrl: 'http://127.0.0.1:3000',
  apiKey: process.env.EVALHUB_API_KEY,   // 与 token 二选一
  tenant: 'risk-dept',                   // 可选，默认落在密钥所属业务线
});
```

## 主要方法

| 方法 | 说明 |
|---|---|
| `health()` | 服务与租户上下文 |
| `createRun({provider, model, ids, config})` | 建评测任务，立即返回 |
| `waitRun(id, {timeoutMs, intervalMs, onProgress})` | 轮询到终态 |
| `results(id)` | 逐条结果（已把 `{count,rows}` 归一化成数组） |
| `aggregate(id)` | 五维 + 总分均值，只统计有分数的行 |
| `runAndAggregate(opts)` | 建任务 → 等待 → 汇总 |
| `gate({key, version, scores})` | 服务端口径判定 |
| `compare(a, b)` | 两次任务对比（含口径与数据集一致性校验） |
| `rubrics()` | 当前业务线的口径与版本 |

## 错误处理

所有失败抛 `EvalHubError`，带 `status` 与 `path`：

```js
import { EvalHubError } from './evalhub-client.mjs';
try {
  await client.createRun({ provider: 'glm' });
} catch (e) {
  if (e instanceof EvalHubError && e.status === 403) console.error('权限不足', e.message);
}
```
