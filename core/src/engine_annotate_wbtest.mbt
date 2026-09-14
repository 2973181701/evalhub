///|
/// 标注引擎单测（whitebox，同包直调）
/// 用例覆盖：5 类校验失败 + 4 类质检标记 + 真实标注数据回放

///|
/// ============ 测试共享小工具（本包 whitebox 测试共用） ============

///|
fn t_parse(s : String) -> Json {
  @json.parse(s) catch {
    _ => Json::null()
  }
}

///|
fn t_bool(j : Json, key : String) -> Bool {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::True) => true
        _ => false
      }
    _ => false
  }
}

///|
fn t_str(j : Json, key : String) -> String {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::String(s)) => s
        _ => "<missing>"
      }
    _ => "<not-object>"
  }
}

///|
fn t_num(j : Json, key : String) -> Double {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Number(v, ..)) => v
        _ => -1.0
      }
    _ => -1.0
  }
}

///|
fn t_arr(j : Json, key : String) -> Array[Json] {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Array(a)) => a
        _ => []
      }
    _ => []
  }
}

///|
fn t_arr_has_str(arr : Array[Json], target : String) -> Bool {
  for item in arr {
    match item {
      Json::String(s) => if s == target { return true }
      _ => ()
    }
  }
  false
}

///|
fn t_len(arr : Array[Json]) -> Int {
  arr.length()
}

///|
/// 判断字段是否为 JSON null（用于验证「样本不足就返回 null」的契约）
fn t_is_null(j : Json, key : String) -> Bool {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Null) => true
        _ => false
      }
    _ => false
  }
}

///|
/// ============ 校验失败用例 ============

///|
test "标注校验：合法标注 → valid=true 且无错误" {
  let j = t_parse(
    annotate_engine(
      "{\"id\":\"K01\",\"answer_A\":\"北京\",\"answer_B\":\"中国的首都是北京，北京是政治文化中心。\",\"choice\":\"A\",\"reason\":\"选 A：依据维度 5 表达质量，A 直接给出答案，B 冗余。\",\"confidence\":5}",
    ),
  )
  assert_true(t_bool(j, "valid"))
  assert_eq(t_len(t_arr(j, "errors")), 0)
  assert_eq(t_str(j, "choice"), "A")
}

///|
test "标注校验：非法 choice → valid=false 且报出 choice 错误" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "C",
    "选 C 因为……",
    Some(4.0),
  )
  assert_false(c.valid)
  assert_true(c.errors.length() == 1)
  assert_true(contains_str(c.errors[0], "choice"))
}

///|
test "标注校验：空 choice → valid=false" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "   ",
    "选 A 因为简洁",
    Some(4.0),
  )
  assert_false(c.valid)
}

///|
test "标注校验：reason 为空 → valid=false（禁止只选不写）" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "A",
    "   \n ",
    Some(4.0),
  )
  assert_false(c.valid)
  assert_true(contains_str(c.errors[0], "reason"))
}

///|
test "标注校验：confidence 越界 0 与 6 → valid=false" {
  assert_false(
    validate_annotation(
      "K01",
      "北京",
      "上海",
      "A",
      "选 A 因为简洁",
      Some(0.0),
    ).valid,
  )
  assert_false(
    validate_annotation(
      "K01",
      "北京",
      "上海",
      "A",
      "选 A 因为简洁",
      Some(6.0),
    ).valid,
  )
}

///|
test "标注校验：confidence 非整数 3.5 → valid=false" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "A",
    "选 A 因为简洁",
    Some(3.5),
  )
  assert_false(c.valid)
  assert_true(contains_str(c.errors[0], "整数"))
}

///|
test "标注校验：confidence 缺失 → valid=false" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "A",
    "选 A 因为简洁",
    None,
  )
  assert_false(c.valid)
  assert_true(contains_str(c.errors[0], "confidence"))
}

///|
test "标注校验：answer_A 为空 → valid=false（没有比较对象）" {
  let c = validate_annotation(
    "K01",
    "",
    "上海",
    "A",
    "选 A 因为简洁",
    Some(4.0),
  )
  assert_false(c.valid)
  assert_true(contains_str(c.errors[0], "answer_A"))
}

///|
/// ============ 质检标记用例（不阻断入库） ============

///|
test "质检标记：confidence ≤ 2 → low_confidence（仍 valid）" {
  let c = validate_annotation(
    "R04",
    "答案是 B",
    "推导后结论是 A",
    "平手",
    "平手：两者均未正确解出，瑕疵相当。",
    Some(2.0),
  )
  assert_true(c.valid)
  assert_true(c.flags.length() >= 1)
  assert_true(t_arr_has_str(t_flags_json(c), "low_confidence"))
}

///|
test "质检标记：平手 → tie_needs_review（规范要求慎用）" {
  let c = validate_annotation(
    "S02",
    "5G推动物联网发展",
    "5G推动物联网发展。",
    "tie",
    "平手：两回答文本完全相同。",
    Some(5.0),
  )
  assert_true(c.valid)
  assert_true(t_arr_has_str(t_flags_json(c), "tie_needs_review"))
}

///|
test "质检标记：理由过短 → reason_too_short" {
  let c = validate_annotation(
    "K01",
    "北京",
    "上海",
    "A",
    "A 更好",
    Some(4.0),
  )
  assert_true(c.valid)
  assert_true(t_arr_has_str(t_flags_json(c), "reason_too_short"))
}

///|
test "质检标记：A 与 B 文本完全相同 → identical_answers" {
  let c = validate_annotation(
    "S02",
    "5G推动物联网发展。",
    "5G推动物联网发展。",
    "A",
    "选 A：两者文本相同但更简洁。",
    Some(4.0),
  )
  assert_true(c.valid)
  assert_true(t_arr_has_str(t_flags_json(c), "identical_answers"))
}

///|
test "质检标记：高置信度 + 非平手 + 理由充分 → 无任何标记" {
  let c = validate_annotation(
    "K01",
    "北京",
    "中国的首都是北京，北京是政治文化中心。",
    "A",
    "选 A：事实准确性与 B 一致，依据维度 5 表达质量，A 更简洁。",
    Some(5.0),
  )
  assert_true(c.valid)
  assert_eq(c.flags.length(), 0)
}

///|
/// ============ choice 归一化用例 ============

///|
test "choice 归一化：小写 a/b、前后空格、tie 均被接受" {
  assert_eq(normalize_choice(" a "), "A")
  assert_eq(normalize_choice("B"), "B")
  assert_eq(normalize_choice("平手"), "平手")
  assert_eq(normalize_choice(" tie "), "平手")
  assert_eq(normalize_choice("TIE"), "平手")
  assert_eq(normalize_choice("C"), "")
  assert_eq(normalize_choice(""), "")
}

///|
/// ============ 真实数据回放 ============

///|
test "真实标注回放：K02（判 B，因 A 事实错误）→ valid" {
  let j = t_parse(
    annotate_engine(
      "{\"id\":\"K02\",\"answer_A\":\"二氧化碳和水\",\"answer_B\":\"光合作用需要光能、水、二氧化碳。\",\"choice\":\"B\",\"reason\":\"选 B：依据维度 1 事实准确性——A 把光能列为原料，存在概念错误。\",\"confidence\":4}",
    ),
  )
  assert_true(t_bool(j, "valid"))
  assert_eq(t_str(j, "choice"), "B")
  assert_eq(t_num(j, "confidence"), 4.0)
}

///|
test "非法 JSON 输入：标注引擎返回 error 字段且不向宿主抛错" {
  let out = annotate_engine("{不是 json")
  assert_true(contains_str(out, "invalid_json"))
}

///|
/// 测试辅助：把 AnnotationCheck 的 flags 直接转成 Json 数组，便于复用 t_arr_has_str
fn t_flags_json(c : AnnotationCheck) -> Array[Json] {
  let out : Array[Json] = []
  for s in c.flags {
    out.push(Json::string(s))
  }
  out
}
