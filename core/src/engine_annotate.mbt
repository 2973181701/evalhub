///|
/// 标注引擎 · A/B 偏好标注校验 + 质检标记（纯规则、确定性、可单测）
///
/// 数据契约（JSON in → JSON out）：
/// 输入
/// {
///   "id": "K01",
///   "answer_A": "...", "answer_B": "...",
///   "choice": "A",          // A / B / 平手（大小写与空白不敏感；tie 视为平手）
///   "reason": "选 A：...",
///   "confidence": 4         // 1–5 的整数
/// }
/// 输出
/// { "id":"K01", "valid": true, "errors": [], "flags": [], "choice": "A", "confidence": 4 }
///
/// 校验失败（valid=false，拒绝入库）：
///   1. id 非空
///   2. choice ∈ {A, B, 平手}
///   3. reason 去掉空白后非空
///   4. confidence 是 1–5 的整数
///   5. answer_A / answer_B 均非空（没有比较对象就无从标注）
///
/// 质检标记（flags，不阻断入库，只提示人工复核）：
///   low_confidence   confidence ≤ 2
///   reason_too_short 理由去空白后 < 8 字（规范要求写明维度 + 对方差在哪）
///   tie_needs_review 选了平手（规范要求「慎用」，需复核）
///   identical_answers A 与 B 文本完全相同（该样本无区分度）
///
/// 输入不是合法 JSON 时输出 { "error": "invalid_json" }，绝不向宿主抛错。

///|
/// 单条标注的校验结果（typed 纯函数用；JSON 边界由 annotate_engine 负责）
pub struct AnnotationCheck {
  valid : Bool
  errors : Array[String]
  flags : Array[String]
  choice : String
  confidence : Int
}

///|
/// 对外入口：JSON 字符串进，JSON 字符串出。
pub fn annotate_engine(input : String) -> String {
  let j = try @json.parse(input) catch {
    _ => return error_json("invalid_json")
  }
  let c = validate_annotation(
    get_str(j, "id"),
    get_str(j, "answer_A"),
    get_str(j, "answer_B"),
    get_str(j, "choice"),
    get_str(j, "reason"),
    get_num_field(j, "confidence"),
  )
  check_json(get_str(j, "id"), c)
}

///|
/// typed 版本：校验 + 质检标记（可被单测直接调用）
pub fn validate_annotation(
  id : String,
  answer_a : String,
  answer_b : String,
  choice_raw : String,
  reason : String,
  confidence : Double?
) -> AnnotationCheck {
  let errors : Array[String] = []
  let flags : Array[String] = []

  // ① id
  if blank(id) {
    errors.push("id 不能为空")
  }

  // ② choice
  let choice = normalize_choice(choice_raw)
  if choice == "" {
    errors.push("choice 必须是 A / B / 平手（收到：" + shorten(choice_raw) + "）")
  }

  // ③ reason
  if blank(reason) {
    errors.push("reason 不能为空（标注规范要求「禁止只选不写」）")
  } else if no_ws_len(reason) < 8 {
    flags.push("reason_too_short")
  }

  // ④ confidence
  let mut conf = 0
  match confidence {
    Some(v) =>
      if v < 1.0 || v > 5.0 {
        errors.push("confidence 必须在 1–5 之间（收到 " + v.to_string() + "）")
      } else if v != Double::from_int(v.to_int()) {
        errors.push("confidence 必须是整数（收到 " + v.to_string() + "）")
      } else {
        conf = v.to_int()
      }
    None => errors.push("confidence 缺失或不是数字")
  }

  // ⑤ 待比较的两个回答
  if blank(answer_a) {
    errors.push("answer_A 不能为空")
  }
  if blank(answer_b) {
    errors.push("answer_B 不能为空")
  }

  // 质检标记（与校验失败区分开：这些是「可入库但要复核」）
  if conf >= 1 && conf <= 2 {
    flags.push("low_confidence")
  }
  if choice == "平手" {
    flags.push("tie_needs_review")
  }
  if !blank(answer_a) && answer_a == answer_b {
    flags.push("identical_answers")
  }

  {
    valid: errors.length() == 0,
    errors,
    flags,
    choice,
    confidence: conf,
  }
}

///|
/// ===================== 以下为内部辅助（纯函数） =====================

///|
/// 空白字符：空格 / Tab / 换行 / 回车 / 全角空格
fn is_space_code(c : Int) -> Bool {
  c == 32 || c == 9 || c == 10 || c == 13 || c == 0x3000
}

///|
/// 去掉空白后的码元序列（本引擎内部统一用它做「忽略格式差异」的比较）
fn no_ws_codes(s : String) -> Array[Int] {
  let out : Array[Int] = []
  for ch in s {
    let c = ch.to_int()
    if !is_space_code(c) {
      out.push(c)
    }
  }
  out
}

///|
fn no_ws_len(s : String) -> Int {
  no_ws_codes(s).length()
}

///|
fn blank(s : String) -> Bool {
  no_ws_len(s) == 0
}

///|
/// 归一化 choice：忽略大小写与空白，tie/TIE/平手 → "平手"；非法返回 ""
fn normalize_choice(raw : String) -> String {
  let cs = no_ws_codes(raw)
  if cs.length() == 1 {
    let c = cs[0]
    if c == 65 || c == 97 {
      return "A"
    }
    if c == 66 || c == 98 {
      return "B"
    }
    return ""
  }
  if cs == [0x5E73, 0x624B] {
    return "平手"
  }
  if cs == [116, 105, 101] || cs == [84, 73, 69] {
    return "平手"
  }
  ""
}

///|
/// 错误信息里回显用户输入时截断，避免超长文本污染日志
fn shorten(s : String) -> String {
  let cs = no_ws_codes(s)
  if cs.length() <= 12 {
    return s
  }
  let head : Array[Char] = []
  let mut i = 0
  for ch in s {
    if i >= 12 {
      break
    }
    head.push(ch)
    i = i + 1
  }
  String::from_array(head) + "…"
}

///|
/// 取数值字段；缺失 / 类型不对返回 None（与「值为 0」区分开）
fn get_num_field(j : Json, key : String) -> Double? {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Number(v, ..)) => Some(v)
        _ => None
      }
    _ => None
  }
}

///|
fn str_array_json(items : Array[String]) -> Json {
  let out : Array[Json] = []
  for s in items {
    out.push(Json::string(s))
  }
  Json::array(out)
}

///|
fn check_json(id : String, c : AnnotationCheck) -> String {
  let m : Map[String, Json] = Map([], capacity=8)
  m["id"] = Json::string(id)
  m["valid"] = Json::boolean(c.valid)
  m["errors"] = str_array_json(c.errors)
  m["flags"] = str_array_json(c.flags)
  m["choice"] = Json::string(c.choice)
  m["confidence"] = Json::number(Double::from_int(c.confidence))
  Json::object(m).stringify()
}
