///|
/// 约束遵循引擎 · Constraint Gate（纯规则、确定性、可单测）
///
/// 【为什么需要它】
/// 平台原有五维评分里，accuracy / completeness 都靠「与参考文本的词面重合」。
/// 这带来一个结构性缺陷：答案越长，越可能覆盖参考词，分越高。
/// 于是「按题目要求把答案说短」这种正确行为反被扣分——实测 E01 题面要求
/// 判断情绪（给三个候选标签之一），微调模型只回「负面」两个字，规则分 3.70；
/// 基线模型回了 117 字分析，规则分 4.70。方向是反的。
///
/// 本引擎回答另一个问题：**这条回答有没有遵守题面写明的约束**。
/// 约束从题面自动解析（字数上限 / 句数 / 标签集合 / 代码 / 两步作答 / JSON），
/// 判定只看答案本身，不看参考答案、也不看长度偏好，因此与词面重合度正交。
///
/// 【数据契约】JSON in → JSON out
/// 输入  { "prompt": "...", "answer": "..." }
/// 输出  {
///   "constraint": 4.5,        // 约束遵循分 0–5 = 5 × 通过项 / 适用项
///   "gate": "pass|warn|fail", // 门禁结论
///   "critical_failed": 0,     // 未满足的硬约束条数
///   "applicable": 4,          // 适用约束数（题面没提的不算，不虚增分母）
///   "checks": [ {kind, severity, label, ok, detail} ]
/// }
///
/// 【门禁策略】硬约束全满足 → pass；1 条未满足 → warn（总分封顶 3.5）；
/// ≥2 条未满足 → fail（封顶 2.0）。封顶值集中在 gate_cap()，便于按业务调整。
/// 约束是「门禁」而不是又一个平均分维度：把违规平均进均分会被长度分稀释掉，
/// 拿不到「没按要求作答就不合格」的语义。

///|
/// 一条从题面解析出的约束（typed 版本用；JSON 边界由 constraint_engine 负责）
pub struct Requirement {
  kind : String
  num : Int
  labels : Array[String]
}

///|
/// 单条约束的判定结果
pub struct ConstraintCheck {
  kind : String
  severity : String
  label : String
  ok : Bool
  detail : String
}

///|
/// 整份约束报告
pub struct ConstraintReport {
  checks : Array[ConstraintCheck]
  applicable : Int
  passed : Int
  critical_failed : Int
  score : Double
  gate : String
  review_items : Array[String]
}

///|
/// 对外入口：JSON 字符串进，JSON 字符串出
pub fn constraint_engine(input : String) -> String {
  let j = @json.parse(input) catch { _ => return error_json("invalid_json") }
  let r = check_constraints(get_str(j, "prompt"), get_str(j, "answer"))
  report_json(r)
}

///|
/// 从题面解析可机检的约束。题面没写就不产生约束（不臆测要求）。
pub fn parse_requirements(prompt : String) -> Array[Requirement] {
  let out : Array[Requirement] = []
  let cs = prompt.to_array()

  // 1. 字数上限：「不超过30字」「15字以内」「50个字符以内」
  let mut cap = int_after(cs, "不超过")
  if cap <= 0 {
    cap = int_before(cs, "字以内")
  }
  if cap <= 0 {
    cap = int_before(cs, "个字符")
  }
  if cap > 0 {
    out.push({ kind: "max_chars", num: cap, labels: [] })
  }

  // 2. 句数：「用3句话」「一句话」
  let mut sent = int_before(cs, "句话")
  if sent <= 0 && contains_str(prompt, "一句话") {
    sent = 1
  }
  if sent > 0 {
    out.push({ kind: "sentence_count", num: sent, labels: [] })
  }

  // 3. 标签集合：「判断这句话的情绪（正面/负面/中性）」
  let labels = parse_label_set(cs)
  if labels.length() >= 2 {
    out.push({ kind: "label_set", num: 0, labels: labels })
  }

  // 4. 代码：「用 Python 写一个函数」
  if contains_str(prompt, "Python") ||
    contains_str(prompt, "python") ||
    contains_str(prompt, "写一个函数") ||
    contains_str(prompt, "写函数") {
    out.push({ kind: "code", num: 0, labels: [] })
  }

  // 5. 两步作答：「请先判断…，再回答」
  if contains_str(prompt, "先") &&
    (contains_str(prompt, "再") || contains_str(prompt, "然后")) {
    out.push({ kind: "two_step", num: 0, labels: [] })
  }

  // 6. JSON 输出：「以 JSON 格式返回」
  if (contains_str(prompt, "JSON") || contains_str(prompt, "json")) &&
    (contains_str(prompt, "返回") ||
      contains_str(prompt, "格式") ||
      contains_str(prompt, "输出")) {
    out.push({ kind: "json", num: 0, labels: [] })
  }

  out
}

///|
/// 逐条判定约束 + 一条通用软约束（元话语），汇总成报告
pub fn check_constraints(prompt : String, answer : String) -> ConstraintReport {
  let reqs = parse_requirements(prompt)
  let checks : Array[ConstraintCheck] = []
  let text = strip_noise(answer)
  let chars = text.char_length()
  let empty = trim_str(answer).char_length() == 0

  // 通用硬约束：没作答就谈不上「守约束」。空答案会「通过」字数上限，
  // 所以必须单列这一条，否则空答案会被判成合规。
  checks.push({
    kind: "non_empty",
    severity: "critical",
    label: "非空作答",
    ok: !empty,
    detail: if empty { "答案为空" } else { "共 " + chars.to_string() + " 字" },
  })

  for r in reqs {
    if r.kind == "max_chars" {
      checks.push({
        kind: "max_chars",
        severity: "critical",
        label: "字数上限",
        ok: chars <= r.num,
        detail: "实际 " + chars.to_string() + " 字 / 上限 " + r.num.to_string() + " 字",
      })
    } else if r.kind == "sentence_count" {
      let n = count_sentences(answer)
      checks.push({
        kind: "sentence_count",
        severity: "critical",
        label: "句数",
        ok: n == r.num,
        detail: "实际 " + n.to_string() + " 句 / 要求 " + r.num.to_string() + " 句",
      })
    } else if r.kind == "label_set" {
      // 硬约束：答案里必须出现候选集合中的标签（一个都没给 = 没作答）
      let hit : Array[String] = []
      for lb in r.labels {
        if contains_str(answer, lb) && !array_contains_str(hit, lb) {
          hit.push(lb)
        }
      }
      checks.push({
        kind: "label_present",
        severity: "critical",
        label: "标签命中",
        ok: hit.length() >= 1,
        detail: "候选 " +
          join_str(r.labels, "/") +
          (if hit.length() > 0 { "；命中 " + join_str(hit, "、") } else { "；未命中任何标签" }),
      })
      // 复核项：出现两个以上不同标签。规则判不了「到底是哪个」——
      // 解释性答案里会出现「没有表达正面或负面的情绪」这种否定引用，
      // 机械计数会误判。所以不罚分、不阻断，只标记待人工确认。
      checks.push({
        kind: "label_unique",
        severity: "review",
        label: "标签不冲突",
        ok: hit.length() <= 1,
        detail: if hit.length() <= 1 {
          "仅一个标签"
        } else {
          "出现 " + hit.length().to_string() + " 个不同标签，需人工确认结论"
        },
      })
      // 软约束：除标签外没有多余解释（题面只要求判断情绪，没要求讲理由）
      let only = hit.length() == 1 && text == hit[0]
      checks.push({
        kind: "label_only",
        severity: "minor",
        label: "只给标签",
        ok: only,
        detail: if only { "仅输出标签" } else { "标签外另有 " + chars.to_string() + " 字说明" },
      })
    } else if r.kind == "code" {
      let ok = contains_str(answer, "def ") ||
        contains_str(answer, "```") ||
        contains_str(answer, "function") ||
        contains_str(answer, "return")
      checks.push({
        kind: "code",
        severity: "critical",
        label: "给出代码",
        ok,
        detail: if ok { "含可执行代码" } else { "未见函数定义或代码块" },
      })
    } else if r.kind == "two_step" {
      let step1 = contains_str(answer, "前提") ||
        contains_str(answer, "不正确") ||
        contains_str(answer, "错误") ||
        contains_str(answer, "不成立")
      let step2 = contains_str(answer, "会飞") ||
        contains_str(answer, "不会") ||
        contains_str(answer, "结论") ||
        contains_str(answer, "所以") ||
        contains_str(answer, "因此")
      let ok = step1 && step2
      checks.push({
        kind: "two_step",
        severity: "critical",
        label: "两步作答",
        ok,
        detail: "前提判断 " + (if step1 { "有" } else { "无" }) +
          " / 结论 " + (if step2 { "有" } else { "无" }),
      })
    } else if r.kind == "json" {
      let ok = contains_str(answer, "{") && contains_str(answer, "}")
      checks.push({
        kind: "json",
        severity: "critical",
        label: "JSON 输出",
        ok,
        detail: if ok { "含 JSON 对象" } else { "未见 JSON 对象" },
      })
    }
  }

  // 通用软约束：元话语开场（「当然可以！下面是…」）。不影响门禁，只记一笔。
  let meta = has_meta_prefix(answer)
  checks.push({
    kind: "no_meta",
    severity: "minor",
    label: "无元话语",
    ok: !meta,
    detail: if meta { "以套话开场" } else { "直接作答" },
  })

  let mut passed = 0
  let mut critical_failed = 0
  let mut scored = 0
  let review_items : Array[String] = []
  for c in checks {
    if c.severity == "review" {
      // 复核项既不奖也不罚：规则没有判定能力时，不该假装有
      if !c.ok {
        review_items.push(c.label + "：" + c.detail)
      }
    } else {
      scored = scored + 1
      if c.ok {
        passed = passed + 1
      } else if c.severity == "critical" {
        critical_failed = critical_failed + 1
      }
    }
  }
  let applicable = scored
  let score = if applicable == 0 {
    5.0
  } else {
    round2(5.0 * Double::from_int(passed) / Double::from_int(applicable))
  }
  let gate = if empty {
    "fail"
  } else if critical_failed == 0 {
    "pass"
  } else if critical_failed == 1 {
    "warn"
  } else {
    "fail"
  }
  {
    checks: checks,
    applicable: applicable,
    passed: passed,
    critical_failed: critical_failed,
    score: score,
    gate: gate,
    review_items: review_items,
  }
}

///|
/// 门禁对总分的封顶值。集中一处，便于按业务口径调整。
pub fn gate_cap(gate : String) -> Double {
  if gate == "fail" {
    2.0
  } else if gate == "warn" {
    3.5
  } else {
    5.0
  }
}

///|
/// ===================== 内部辅助（纯函数） =====================

///|
/// 标签集合：取第一个括号内的 "A/B/C" 形式，2–5 项且各项 ≤6 字才算
fn parse_label_set(cs : Array[Char]) -> Array[String] {
  let n = cs.length()
  let mut start = -1
  let mut i = 0
  while i < n {
    let c = cs[i].to_int()
    if c == 0xFF08 || c == 40 {
      start = i
      break
    }
    i = i + 1
  }
  if start < 0 {
    return []
  }
  let mut end = -1
  let mut j = start + 1
  while j < n {
    let c = cs[j].to_int()
    if c == 0xFF09 || c == 41 {
      end = j
      break
    }
    j = j + 1
  }
  if end < 0 {
    return []
  }
  let parts = split_chars(cs, start + 1, end, 47)
  if parts.length() < 2 || parts.length() > 5 {
    return []
  }
  let out : Array[String] = []
  for p in parts {
    let t = trim_str(p)
    if t.char_length() == 0 || t.char_length() > 6 {
      return []
    }
    out.push(t)
  }
  out
}

///|
/// 按码元切分 [a, b) 区间，sep 为分隔符码元（47 = '/'）
fn split_chars(cs : Array[Char], a : Int, b : Int, sep : Int) -> Array[String] {
  let out : Array[String] = []
  let buf = StringBuilder()
  let mut i = a
  while i < b && i < cs.length() {
    if cs[i].to_int() == sep {
      out.push(buf.to_string())
      buf.reset()
    } else {
      buf.write_char(cs[i])
    }
    i = i + 1
  }
  out.push(buf.to_string())
  out
}

///|
fn trim_str(s : String) -> String {
  let cs = s.to_array()
  let n = cs.length()
  let mut a = 0
  while a < n && is_space_code(cs[a].to_int()) {
    a = a + 1
  }
  let mut b = n
  while b > a && is_space_code(cs[b - 1].to_int()) {
    b = b - 1
  }
  let buf = StringBuilder()
  let mut i = a
  while i < b {
    buf.write_char(cs[i])
    i = i + 1
  }
  buf.to_string()
}

///|
/// 只保留文字字符（ASCII 字母数字 / CJK），用于字数统计与「只给标签」比对
fn strip_noise(s : String) -> String {
  let buf = StringBuilder()
  for ch in s {
    if is_word_code(ch.to_int()) {
      buf.write_char(ch)
    }
  }
  buf.to_string()
}

///|
/// 句子数：按 。！？!? 切分，只统计含文字字符的段
fn count_sentences(s : String) -> Int {
  let mut n = 0
  let mut cur = 0
  for ch in s {
    let c = ch.to_int()
    if c == 0x3002 || c == 0xFF01 || c == 0xFF1F || c == 33 || c == 63 {
      if cur > 0 {
        n = n + 1
      }
      cur = 0
    } else if is_word_code(c) {
      cur = cur + 1
    }
  }
  if cur > 0 {
    n = n + 1
  }
  n
}

///|
fn has_meta_prefix(answer : String) -> Bool {
  let t = trim_str(answer)
  let mut hit = false
  for m in meta_prefixes() {
    if starts_with_str(t, m) {
      hit = true
    }
  }
  hit
}

///|
fn starts_with_str(s : String, prefix : String) -> Bool {
  let a = s.to_array()
  let b = prefix.to_array()
  if b.length() > a.length() {
    return false
  }
  let mut i = 0
  let mut ok = true
  while i < b.length() {
    if a[i].to_int() != b[i].to_int() {
      ok = false
      break
    }
    i = i + 1
  }
  ok
}

///|
fn join_str(arr : Array[String], sep : String) -> String {
  let buf = StringBuilder()
  let mut first = true
  for x in arr {
    if !first {
      buf.write_string(sep)
    }
    buf.write_string(x)
    first = false
  }
  buf.to_string()
}

///|
/// 在 cs 中从 from 开始查找 needle（码元级），返回起始下标或 -1
fn find_codes(cs : Array[Char], from : Int, needle : String) -> Int {
  let nd = needle.to_array()
  let nl = nd.length()
  if nl == 0 {
    return from
  }
  let n = cs.length()
  let mut i = from
  while i + nl <= n {
    let mut ok = true
    let mut j = 0
    while j < nl {
      if cs[i + j].to_int() != nd[j].to_int() {
        ok = false
        break
      }
      j = j + 1
    }
    if ok {
      return i
    }
    i = i + 1
  }
  -1
}

///|
fn is_digit_code(c : Int) -> Bool {
  (c >= 48 && c <= 57) || (c >= 0xFF10 && c <= 0xFF19)
}

///|
fn digit_val(c : Int) -> Int {
  if c >= 48 && c <= 57 {
    c - 48
  } else {
    c - 0xFF10
  }
}

///|
/// 读 cs[i] 起的连续数字，返回 (值, 结束下标)；无数码返回 (-1, i)
fn read_int_at(cs : Array[Char], i : Int) -> (Int, Int) {
  let mut v = 0
  let mut j = i
  let n = cs.length()
  while j < n && is_digit_code(cs[j].to_int()) {
    v = v * 10 + digit_val(cs[j].to_int())
    j = j + 1
  }
  if j == i {
    (-1, i)
  } else {
    (v, j)
  }
}

///|
/// 锚点之后紧跟的数字：「不超过30字」→ 30
fn int_after(cs : Array[Char], anchor : String) -> Int {
  let pos = find_codes(cs, 0, anchor)
  if pos < 0 {
    return -1
  }
  let (v, _) = read_int_at(cs, pos + anchor.char_length())
  v
}

///|
/// 锚点之前紧邻的数字：「15字以内」→ 15
fn int_before(cs : Array[Char], anchor : String) -> Int {
  let pos = find_codes(cs, 0, anchor)
  if pos <= 0 {
    return -1
  }
  let mut j = pos - 1
  if !is_digit_code(cs[j].to_int()) {
    return -1
  }
  while j > 0 && is_digit_code(cs[j - 1].to_int()) {
    j = j - 1
  }
  let (v, _) = read_int_at(cs, j)
  v
}

///|
fn meta_prefixes() -> Array[String] {
  [
    "当然可以", "当然", "好的", "以下是", "下面是", "根据题目", "根据参考",
    "我们来", "这道题", "这是一个", "下面是", "以下为",
  ]
}

///|
/// ===================== JSON 边界 =====================

///|
fn check_json_obj(c : ConstraintCheck) -> Json {
  let m : Map[String, Json] = Map([], capacity=6)
  m["kind"] = Json::string(c.kind)
  m["severity"] = Json::string(c.severity)
  m["label"] = Json::string(c.label)
  m["ok"] = Json::boolean(c.ok)
  m["detail"] = Json::string(c.detail)
  Json::object(m)
}

///|
fn report_json(r : ConstraintReport) -> String {
  let arr : Array[Json] = []
  for c in r.checks {
    arr.push(check_json_obj(c))
  }
  let rev : Array[Json] = []
  for x in r.review_items {
    rev.push(Json::string(x))
  }
  let m : Map[String, Json] = Map([], capacity=8)
  m["constraint"] = Json::number(r.score)
  m["gate"] = Json::string(r.gate)
  m["critical_failed"] = Json::number(Double::from_int(r.critical_failed))
  m["applicable"] = Json::number(Double::from_int(r.applicable))
  m["passed"] = Json::number(Double::from_int(r.passed))
  m["needs_review"] = Json::array(rev)
  m["checks"] = Json::array(arr)
  Json::object(m).stringify()
}
