///|
/// WASM ABI 适配层 —— 让 WASM 形态的引擎也能被 JS 调用。
///
/// ## 为什么需要这一层
///
/// 四个引擎的对外契约都是「JSON 字符串进 → JSON 字符串出」。
/// 这在 **js 目标**下毫无问题（JS 有字符串类型，直接传）。
/// 但在 **wasm / wasm-gc 目标**下：WebAssembly 的 MVP 与 GC 提案都**没有跨边界的字符串类型**，
/// MoonBit 的 `String` 在 wasm-gc 里是一个 GC 结构体，JS 侧既造不出来也读不出来：
///
/// ```
/// TypeError: type incompatibility when transforming from/to JS
/// ```
///
/// 这不是 MoonBit 的缺陷，而是 WASM 的固有边界。所有语言都要自己适配：
/// Rust 用 wasm-bindgen 生成胶水，C 用手动指针 + 长度，Go 用 syscall/js 桥。
/// 本版本 MoonBit 没有随构建产物输出 JS 胶水，所以这里自己写一个**最小适配层**。
///
/// ## 设计：码点缓冲 + 索引寻址（零依赖、只用 i32）
///
/// 只暴露数字类型，字符串通过一块引擎侧的码点缓冲区搬运：
///
/// ```
/// JS 侧                                     MoonBit 侧
/// ──────────────────────────────────────────────────────────────
/// abi_clear()                        →      清空缓冲区
/// abi_push(cp)   × N                 →      逐个追加输入码点
/// abi_run(op)                        →      把缓冲当输入跑引擎，结果写回缓冲
/// abi_len()                          →      返回输出码点个数
/// abi_read(i)    × N                 →      逐个读出输出码点
/// ```
///
/// JS 侧对应 `for (const ch of s) w.abi_push(ch.codePointAt(0))`
/// 与 `String.fromCodePoint(w.abi_read(i))`。
///
/// ## ⚠️ 关键：搬的是「码点」而不是「UTF-16 码元」
///
/// 这是本层最容易写错的地方，实测确认过 MoonBit 的语义：
///
/// | 表达式 | 结果 | 说明 |
/// |---|---|---|
/// | `"加油💪".length()` | `4` | 按 **UTF-16 码元** 计数（与 JS 一致） |
/// | `for ch in "加油💪"` | 迭代 **3** 次 | 按 **Unicode 码点** 迭代 |
/// | `Int::to_char(0x1F4AA)` | `Some(💪)` | 非 BMP 码点可以表示 |
/// | `Int::to_char(0xD83D)` | `None` | **代理区码元被拒**（不是合法标量值） |
///
/// MoonBit 的 `Char` 是 32 位完整码点，所以缓冲区必须传码点。
/// 如果误传 JS 的 `charCodeAt` 结果（代理对两半），
/// `Int::to_char` 会把两半都判为非法、替换成 U+FFFD，**非 BMP 字符就丢了**。
///
/// 边界代价（诚实声明）：JS 字符串若含**孤立代理**（本身已是非法 UTF-16），
/// 无法用码点表示，会被替换为 U+FFFD。正常文本（含 emoji、生僻字）不受影响。
///
/// ## 边界说明
///
/// 本文件只有「缓冲区搬运 + 按 op 分发」，**不含任何业务计算**。
/// 四个引擎仍然是纯函数，缓冲区只是跨语言边界的传输通道。
/// 这层也只在 wasm-gc 目标下导出（见 `moon.pkg` 的 `link.wasm-gc.exports`），
/// JS 目标不需要它。
///
/// 正确性由两处独立验证：
///   - 包内单测 `engine_wasm_abi_wbtest.mbt`（搬运原语 + op 分发）
///   - 跨语言比对 `tools/wasm_smoke.mjs`（56 项，WASM 与 JS 输出逐字符一致）

///|
/// 跨边界码点缓冲区（引擎侧）。存的是 Unicode 码点（0..0x10FFFF），
/// 与 MoonBit `Char` 的取值范围一致。
let abi_buf : Array[Int] = []

///|
/// op 码：与 `abi_run` 一一对应
fn abi_op_eval() -> Int {
  0
}

///|
fn abi_op_annotate() -> Int {
  1
}

///|
fn abi_op_analyze() -> Int {
  2
}

///|
fn abi_op_consistency() -> Int {
  3
}

///|
fn abi_op_export_rlhf() -> Int {
  4
}

///|
/// ===================== 对外 ABI（全部只涉及 Int） =====================

///|
/// 清空缓冲区（每次调用引擎前必须先调）
pub fn abi_clear() -> Unit {
  abi_buf.clear()
}

///|
/// 追加一个输入**码点**（不是 UTF-16 码元，见文件头说明）
pub fn abi_push(code_point : Int) -> Unit {
  abi_buf.push(code_point)
}

///|
/// 输出码点个数
pub fn abi_len() -> Int {
  abi_buf.length()
}

///|
/// 读取第 i 个输出**码点**（越界返回 -1，方便宿主判断读完）
pub fn abi_read(i : Int) -> Int {
  if i < 0 || i >= abi_buf.length() {
    -1
  } else {
    abi_buf[i]
  }
}

///|
/// 用缓冲区内容当输入，跑指定引擎，把结果写回缓冲区。
///
/// op: 0=评测 1=标注 2=分析 3=一致性 4=RLHF 导出
/// 未知 op 时缓冲区被写成 {"error":"unknown_op"}，宿主能立刻发现用错了。
pub fn abi_run(op : Int) -> Unit {
  let input = abi_buf_to_string()
  let output = if op == abi_op_eval() {
    eval_engine(input)
  } else if op == abi_op_annotate() {
    annotate_engine(input)
  } else if op == abi_op_analyze() {
    analyze_engine(input)
  } else if op == abi_op_consistency() {
    consistency_engine(input)
  } else if op == abi_op_export_rlhf() {
    export_rlhf(input)
  } else {
    error_json("unknown_op")
  }
  abi_buf.clear()
  for ch in output {
    abi_buf.push(ch.to_int())
  }
}

///|
/// 引擎版本（返回码点长度，内容同样通过 abi_read 读）。
/// 单列一个函数是因为「先验证 ABI 通路、再验证业务逻辑」是更清晰的排查顺序。
pub fn abi_version() -> Unit {
  abi_buf.clear()
  for ch in version() {
    abi_buf.push(ch.to_int())
  }
}

///|
/// ===================== 内部辅助 =====================

///|
/// 码点数组 → String
///
/// 边界兜底：JS 侧若推入非法码点（负数 / 超出 U+10FFFF / 代理区 0xD800–0xDFFF），
/// 用 U+FFFD（替换字符）占位，而不是让整个引擎崩掉。
/// 这样非法输入会以「字符串内容异常」的形式暴露在 JSON 输出里，宿主能看见。
fn abi_buf_to_string() -> String {
  let chars : Array[Char] = []
  for c in abi_buf {
    match Int::to_char(c) {
      Some(ch) => chars.push(ch)
      None => chars.push('\uFFFD')
    }
  }
  String::from_array(chars)
}
