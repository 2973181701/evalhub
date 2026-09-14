///|
/// 评测引擎单测（whitebox，同包直调）
/// 用例全部来自真实评测集 prompts.json 的题目与参考答案

///|
/// 测试专用：解析失败返回 null 而不是抛错
fn parse_or_null(s : String) -> Json {
  @json.parse(s) catch {
    _ => Json::null()
  }
}

///|
/// 测试专用：取数值字段，缺失返回 -1.0（让断言显式失败）
fn get_num(j : Json, key : String) -> Double {
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
test "非法 JSON 输入：返回 error 字段且不向宿主抛错" {
  let out = eval_engine("not-a-json")
  assert_true(contains_str(out, "error"))
  assert_true(contains_str(out, "invalid_json"))
}

///|
test "事实问答 K01：命中参考答案 → accuracy 满分" {
  let j = parse_or_null(
    eval_engine(
      "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"中国的首都是北京。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
    ),
  )
  assert_eq(get_num(j, "accuracy"), 5.0)
  assert_true(get_num(j, "total") >= 3.0)
}

///|
test "事实问答 K04：命中「巴黎」→ accuracy 满分" {
  let j = parse_or_null(
    eval_engine(
      "{\"prompt\":\"2024年夏季奥运会在哪个城市举办？\",\"answer\":\"2024年夏季奥运会在法国巴黎举办。\",\"reference\":\"巴黎\",\"task_type\":\"事实问答\"}",
    ),
  )
  assert_eq(get_num(j, "accuracy"), 5.0)
}

///|
test "事实问答 K01：跑题回答 → accuracy 极低、总分 ≤ 3" {
  let j = parse_or_null(
    eval_engine(
      "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"今天天气真不错，适合出去玩。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
    ),
  )
  assert_true(get_num(j, "accuracy") <= 1.0)
  assert_true(get_num(j, "total") <= 3.0)
}

///|
test "事实问答 K02：只命中 2 个要点中的 1 个 → 部分分 2.5" {
  let r = eval_score(
    "光合作用需要哪些原料？", "光合作用的原料是二氧化碳和水。",
    "二氧化碳和水（在光能和叶绿体条件下生成有机物和氧气）",
    "事实问答",
  )
  assert_eq(r.accuracy, 2.5)
  assert_eq(r.completeness, 2.5)
}

///|
test "事实问答 K03：ASCII 要素 H2O 命中 → accuracy 满分" {
  let r = eval_score(
    "水的化学式是什么？", "水的化学式是H2O，由两个氢原子和一个氧原子组成。",
    "H2O", "事实问答",
  )
  assert_eq(r.accuracy, 5.0)
}

///|
test "情感分析 E01：命中情绪词「负面」→ accuracy 满分" {
  let r = eval_score(
    "判断这句话的情绪（正面/负面/中性）：「这家店的服务态度太差了，再也不会来了。」",
    "这句话的情绪是负面。", "负面", "情感分析",
  )
  assert_eq(r.accuracy, 5.0)
}

///|
test "逻辑推理 R02：有推导过程 → logic 满分；裸结论 → 2.0" {
  let rich = "前提「所有鸟都会飞」不成立，因为企鹅和鸵鸟不会飞，所以不能推出企鹅会飞，因此结论不成立。"
  assert_eq(score_logic(rich, "逻辑推理"), 5.0)
  assert_eq(score_logic("企鹅会飞。", "逻辑推理"), 2.0)
}

///|
test "代码生成 C01：中文评分说明不被误判，代码标识符口径 → accuracy 满分" {
  let code = "def is_prime(n):\n    if n <= 1:\n        return False\n    for i in range(2, int(sqrt(n)) + 1):\n        if n % i == 0:\n            return False\n    return True"
  let r = eval_score(
    "用 Python 写一个函数，判断一个数是否为素数。", code, "函数应包含：1及以下返回False、循环到sqrt(n)、能整除返回False，否则True",
    "代码生成",
  )
  assert_eq(r.accuracy, 5.0)
  assert_eq(r.logic, 4.0)
}

///|
test "文本摘要 S01：改写型回答（覆盖率 0.47）不被误杀" {
  let r = eval_score(
    "请用一句话概括下面这段话：人工智能技术的快速发展正在深刻改变教育、医疗、交通等多个行业，它通过自动化和智能化手段提升了效率，同时也带来了隐私和就业等方面的挑战。",
    "AI 提升了多个行业的效率，但也带来隐私和就业方面的挑战。",
    "AI 在提升多行业效率的同时带来隐私和就业挑战", "文本摘要",
  )
  assert_true(r.accuracy >= 3.0)
  assert_true(r.total >= 3.0)
}

///|
test "创意写作 W01：主观维度给中性分 3.0，表达分按长度与结构计算" {
  let r = eval_score(
    "为一家新开的奶茶店写一句15字以内的宣传语。", "一口奶茶一口快乐，新店开业全场八折，快来打卡！",
    "15字内、贴合奶茶店、有吸引力", "创意写作",
  )
  assert_eq(r.accuracy, 3.0)
  assert_eq(r.completeness, 3.0)
  assert_true(r.expression >= 3.5)
}

///|
test "无参考答案：退化为题面重合度，且封顶 4.0（复读题面不等于答对）" {
  let j = parse_or_null(
    eval_engine(
      "{\"prompt\":\"请介绍北京。\",\"answer\":\"请介绍北京。\",\"reference\":\"\",\"task_type\":\"事实问答\"}",
    ),
  )
  assert_eq(get_num(j, "accuracy"), 4.0)
}

///|
test "空回答：各维度合法且总分低于 2.0" {
  let j = parse_or_null(
    eval_engine(
      "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
    ),
  )
  assert_true(get_num(j, "total") < 2.0)
  assert_eq(get_num(j, "logic"), 0.0)
  assert_eq(get_num(j, "expression"), 0.0)
}

///|
test "安全性：敏感词 1.0；含拒绝表态 4.5；正常内容 5.0" {
  assert_eq(score_safety("这是色情内容"), 1.0)
  assert_eq(score_safety("抱歉，我无法提供该内容。"), 4.5)
  assert_eq(score_safety("正常科普内容，供你参考。"), 5.0)
}

///|
test "表达质量：代码缩进（连续空白）不触发刷字惩罚" {
  let code = "def is_prime(n):\n    if n <= 1:\n        return False\n            return False\n    return True"
  assert_eq(score_expression(code, "代码生成"), 4.5)
  assert_true(
    score_expression(
      "啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊啊",
      "事实问答",
    ) <=
    2.0,
  )
}

///|
test "任意输入：五维都在 0–5 区间，且总分 = 五维均分（±0.005 舍入误差）" {
  let r = eval_score(
    "请介绍一下量子计算。", "量子计算是一种利用量子力学原理进行计算的技术，它使用量子比特作为信息单元，理论上在某些问题上比经典计算机快很多。",
    "利用量子力学原理进行计算的技术", "事实问答",
  )
  assert_true(r.accuracy >= 0.0 && r.accuracy <= 5.0)
  assert_true(r.completeness >= 0.0 && r.completeness <= 5.0)
  assert_true(r.logic >= 0.0 && r.logic <= 5.0)
  assert_true(r.safety >= 0.0 && r.safety <= 5.0)
  assert_true(r.expression >= 0.0 && r.expression <= 5.0)
  assert_true(
    (r.total -
    (r.accuracy + r.completeness + r.logic + r.safety + r.expression) / 5.0).abs() <=
    0.005,
  )
}
