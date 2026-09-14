///|
/// WASM ABI 适配层单测（whitebox，同包直调）
///
/// 覆盖三类：
///   1. 缓冲区搬运原语（clear / push / len / read / 越界）
///   2. 码点 ↔ String 往返，含 Unicode 同形字符、非 BMP 字符（emoji）、非法码点兜底
///   3. abi_run 按 op 分发，输出必须与直调引擎**逐字符相同**
///
/// 说明：跨语言（JS ↔ WASM）的真实一致性由 `tools/wasm_smoke.mjs` 验证（56 项比对）。
/// 这里只验「缓冲区搬运 + 分发」这一层本身没写错，所以可以完全在包内跑。

///|
/// 把 String 推进缓冲区（测试用简写）
fn abi_feed(s : String) -> Unit {
  abi_clear()
  for ch in s {
    abi_push(ch.to_int())
  }
}

///|
/// 从缓冲区读回 String（测试用简写）
fn abi_drain() -> String {
  abi_buf_to_string()
}

///|
test "ABI 原语：clear / push / len / read 基本行为" {
  abi_clear()
  assert_eq(abi_len(), 0)
  abi_push(65)
  abi_push(66)
  abi_push(67)
  assert_eq(abi_len(), 3)
  assert_eq(abi_read(0), 65)
  assert_eq(abi_read(1), 66)
  assert_eq(abi_read(2), 67)
  // 越界返回 -1，宿主可据此判断读完
  assert_eq(abi_read(3), -1)
  assert_eq(abi_read(-1), -1)
  abi_clear()
  assert_eq(abi_len(), 0)
}

///|
test "ABI 搬运：ASCII 往返不失真" {
  abi_feed("{\"a\":1}")
  assert_eq(abi_len(), 7)
  assert_eq(abi_drain(), "{\"a\":1}")
}

///|
test "ABI 搬运：中文往返不失真" {
  let s = "中国的首都是北京。"
  abi_feed(s)
  assert_eq(abi_drain(), s)
}

///|
test "ABI 搬运：Unicode 同形字符（下标 ₂）不被吞掉" {
  // U+2082 是下标 2，码点 0x2082。若搬运层按字节截断就会变成乱码。
  let s = "水的化学式是H₂O。"
  abi_feed(s)
  assert_eq(abi_drain(), s)
  assert_eq(abi_len(), 10)
}

///|
test "ABI 搬运：非 BMP 字符（emoji）按一个码点搬运" {
  // 💪 = U+1F4AA，在 UTF-16 里是代理对（占 2 码元），但在 MoonBit 里是 1 个 Char。
  // 关键：搬的必须是码点。若误搬 UTF-16 码元（0xD83D / 0xDCAA），
  // Int::to_char 会把两半都判为非法并替换成 U+FFFD，emoji 就丢了。
  let s = "加油💪"
  abi_feed(s)
  assert_eq(abi_drain(), s)
  assert_eq(abi_len(), 3) // 加 / 油 / 💪 = 3 个码点
  // 对照：同一个字符串的 UTF-16 码元数是 4
  assert_eq(s.length(), 4)
}

///|
test "ABI 搬运：多 emoji 与生僻字混排" {
  let s = "🔥A🔥𠀋" // 𠀋 = U+2000B，另一个非 BMP 码点
  abi_feed(s)
  assert_eq(abi_drain(), s)
  assert_eq(abi_len(), 4)
}

///|
test "ABI 兜底：非法码点替换为 U+FFFD 而不是崩掉" {
  abi_clear()
  abi_push(65) // 'A' 合法
  abi_push(-5) // 非法：负数
  abi_push(0x110000) // 非法：超出 Unicode 上限
  abi_push(0xD83D) // 非法：代理区码元（孤立高代理）
  abi_push(0xDCAA) // 非法：代理区码元（孤立低代理）
  abi_push(66) // 'B' 合法
  let out = abi_drain()
  assert_eq(out.length(), 6)
  assert_eq(out[0], 'A')
  assert_eq(out[1], '\uFFFD')
  assert_eq(out[2], '\uFFFD')
  assert_eq(out[3], '\uFFFD')
  assert_eq(out[4], '\uFFFD')
  assert_eq(out[5], 'B')
}

///|
test "ABI 分发：op=0 评测引擎，输出与直调 eval_engine 完全一致" {
  let input = "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"中国的首都是北京。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}"
  abi_feed(input)
  abi_run(0)
  assert_eq(abi_drain(), eval_engine(input))
}

///|
test "ABI 分发：op=1 标注引擎，输出与直调 annotate_engine 完全一致" {
  let input = "{\"id\":\"K01\",\"answer_A\":\"北京\",\"answer_B\":\"北京是首都。\",\"choice\":\"A\",\"reason\":\"选 A：依据维度 5 表达质量，A 更简洁。\",\"confidence\":5}"
  abi_feed(input)
  abi_run(1)
  assert_eq(abi_drain(), annotate_engine(input))
}

///|
test "ABI 分发：op=2 分析引擎，输出与直调 analyze_engine 完全一致" {
  let input = "{\"scores\":[{\"id\":\"K01\",\"task_type\":\"事实问答\",\"accuracy\":5,\"completeness\":5,\"logic\":3,\"safety\":5,\"expression\":4.5,\"total\":4.5},{\"id\":\"R01\",\"task_type\":\"逻辑推理\",\"accuracy\":0,\"completeness\":3.5,\"logic\":3.5,\"safety\":5,\"expression\":4.5,\"total\":3.3}]}"
  abi_feed(input)
  abi_run(2)
  assert_eq(abi_drain(), analyze_engine(input))
}

///|
test "ABI 分发：op=3 一致性引擎，输出与直调 consistency_engine 完全一致" {
  let input = "{\"records\":[{\"id\":\"K01\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"K01\",\"annotator\":\"rule_judge\",\"choice\":\"B\"},{\"id\":\"K02\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"K02\",\"annotator\":\"rule_judge\",\"choice\":\"A\"}]}"
  abi_feed(input)
  abi_run(3)
  assert_eq(abi_drain(), consistency_engine(input))
}

///|
test "ABI 分发：op=4 数据引擎，输出与直调 export_rlhf 完全一致" {
  let input = "{\"format\":\"dpo\",\"annotations\":[{\"id\":\"K01\",\"task_type\":\"事实问答\",\"prompt\":\"首都是哪？\",\"answer_A\":\"北京\",\"answer_B\":\"北京是首都。\",\"choice\":\"A\"}]}"
  abi_feed(input)
  abi_run(4)
  assert_eq(abi_drain(), export_rlhf(input))
}

///|
test "ABI 分发：未知 op 码 → 缓冲区被写成 unknown_op，宿主能立刻发现" {
  abi_feed("{\"any\":\"thing\"}")
  abi_run(99)
  assert_eq(abi_drain(), "{\"error\":\"unknown_op\"}")
  // 负数 op 同样兜底
  abi_feed("{}")
  abi_run(-1)
  assert_eq(abi_drain(), "{\"error\":\"unknown_op\"}")
}

///|
test "ABI 分发：非法 JSON 输入 → 引擎原有兜底生效，ABI 不额外抛错" {
  abi_feed("not-a-json")
  abi_run(0)
  let out = abi_drain()
  // 与直调结果一致，且是合法 JSON（宿主可安全 parse）
  assert_eq(out, eval_engine("not-a-json"))
  assert_true(out.length() > 0)
}

///|
test "ABI 版本：abi_version 输出与 version() 一致" {
  abi_version()
  assert_eq(abi_drain(), version())
  assert_eq(abi_drain(), "EvalHub core 0.1.0")
}
