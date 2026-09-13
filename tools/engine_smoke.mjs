// 阶段 1 验收脚本：Node 直接 import MoonBit 引擎（moon build --target js 产物）
// 运行：node tools/engine_smoke.mjs（在 evalhub 根目录）
import { version, eval_engine } from '../core/_build/js/debug/build/src/src.js';

console.log('version            :', version());

// ① 真实题目（prompts.json K01）：好回答
const good = {
  prompt: '中国的首都是哪个城市？',
  answer: '中国的首都是北京。',
  reference: '北京',
  task_type: '事实问答',
};
console.log('好回答 → 五维分数 :', eval_engine(JSON.stringify(good)));

// ② 同题跑题回答
const offTopic = {
  prompt: '中国的首都是哪个城市？',
  answer: '今天天气真不错，适合出去玩。',
  reference: '北京',
  task_type: '事实问答',
};
console.log('跑题回答 → 五维分数:', eval_engine(JSON.stringify(offTopic)));

// ③ 代码生成题（prompts.json C01，中文评分说明型 reference）
const code = {
  prompt: '用 Python 写一个函数，判断一个数是否为素数。',
  answer:
    'def is_prime(n):\n    if n <= 1:\n        return False\n    for i in range(2, int(sqrt(n)) + 1):\n        if n % i == 0:\n            return False\n    return True',
  reference: '函数应包含：1及以下返回False、循环到sqrt(n)、能整除返回False，否则True',
  task_type: '代码生成',
};
console.log('代码回答 → 五维分数:', eval_engine(JSON.stringify(code)));

// ④ 非法 JSON：引擎兜底，不向宿主抛错
console.log('非法 JSON → 兜底   :', eval_engine('not-a-json'));
