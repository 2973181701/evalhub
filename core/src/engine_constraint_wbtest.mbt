///|
/// 约束引擎单测（whitebox，同包直调）
/// 用例全部取自真实评测集 prompts.json 的题面与两条真实回答（base / 微调）

///|
fn cparse(s : String) -> Json {
  @json.parse(s) catch {
    _ => Json::null()
  }
}

///|
fn cnum(j : Json, key : String) -> Double {
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
fn cstr(j : Json, key : String) -> String {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::String(s)) => s
        _ => ""
      }
    _ => ""
  }
}

///|
fn cq(prompt : String, answer : String) -> Json {
  let m : Map[String, Json] = Map([], capacity=2)
  m["prompt"] = Json::string(prompt)
  m["answer"] = Json::string(answer)
  cparse(constraint_engine(Json::object(m).stringify()))
}

///|
test "题面解析：不超过30字 → max_chars=30" {
  let reqs = parse_requirements("请用不超过30字概括：随着5G网络的普及……")
  assert_eq(reqs.length(), 1)
  assert_eq(reqs[0].kind, "max_chars")
  assert_eq(reqs[0].num, 30)
}

///|
test "题面解析：15字以内 → max_chars=15" {
  let reqs = parse_requirements("为一家新开的奶茶店写一句15字以内的宣传语。")
  assert_eq(reqs[0].kind, "max_chars")
  assert_eq(reqs[0].num, 15)
}

///|
test "题面解析：用3句话 → sentence_count=3" {
  let reqs = parse_requirements("用3句话写一个关于「坚持」的小故事，要有转折。")
  assert_eq(reqs[0].kind, "sentence_count")
  assert_eq(reqs[0].num, 3)
}

///|
test "题面解析：一句话 → sentence_count=1（无阿拉伯数字）" {
  let reqs = parse_requirements("请用一句话概括下面这段话：人工智能技术的快速发展……")
  assert_eq(reqs[0].kind, "sentence_count")
  assert_eq(reqs[0].num, 1)
}

///|
test "题面解析：（正面/负面/中性）→ 三个标签" {
  let reqs = parse_requirements("判断这句话的情绪（正面/负面/中性）：「这家店的服务态度太差了。」")
  let mut found = false
  for r in reqs {
    if r.kind == "label_set" {
      found = true
      assert_eq(r.labels.length(), 3)
      assert_eq(r.labels[0], "正面")
      assert_eq(r.labels[1], "负面")
      assert_eq(r.labels[2], "中性")
    }
  }
  assert_true(found)
}

///|
test "题面解析：无约束的题不虚增分母（K01 只剩通用软约束）" {
  let reqs = parse_requirements("中国的首都是哪个城市？")
  assert_eq(reqs.length(), 0)
  let j = cq("中国的首都是哪个城市？", "北京")
  // 无题面约束时只剩两条通用项：非空 + 无元话语
  assert_eq(cnum(j, "applicable"), 2.0)
  assert_eq(cnum(j, "constraint"), 5.0)
  assert_eq(cstr(j, "gate"), "pass")
}

///|
test "E01 微调：只回「负面」两个字 → 约束全过" {
  let j = cq("判断这句话的情绪（正面/负面/中性）：「这家店的服务态度太差了，再也不会来了。」", "负面")
  assert_eq(cnum(j, "constraint"), 5.0)
  assert_eq(cstr(j, "gate"), "pass")
}

///|
test "E01 基线：117 字分析含唯一标签 → 硬约束过、软约束不过，但不封顶" {
  let ans = "这句话的情绪是 **负面**。\n\n理由如下：\n\n- “服务态度太差了” 表示对服务的不满。\n- “再也不会来了” 表明失望。"
  let j = cq("判断这句话的情绪（正面/负面/中性）：「这家店的服务态度太差了，再也不会来了。」", ans)
  // 题面只给了标签候选、没写「只回答标签」，所以「只给标签」只能是软约束
  assert_eq(cnum(j, "critical_failed"), 0.0)
  assert_eq(cstr(j, "gate"), "pass")
  assert_true(cnum(j, "constraint") < 5.0)
}

///|
fn cqs(j : Json, key : String) -> Array[String] {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Array(a)) =>
          a.map(
            fn(x) {
              match x {
                Json::String(s) => s
                _ => ""
              }
            },
          )
        _ => []
      }
    _ => []
  }
}

///|
test "E01 两个标签同时出现 → 不判违规，只标记待复核" {
  let j = cq("判断这句话的情绪（正面/负面/中性）：「服务太差了。」", "看起来正面，其实是负面。")
  // 规则判不了「哪个才是结论」，所以不罚分也不阻断——这是刻意设计，不是漏判
  assert_eq(cnum(j, "critical_failed"), 0.0)
  assert_eq(cstr(j, "gate"), "pass")
  assert_eq(cqs(j, "needs_review").length(), 1)
}

///|
test "E01 一个标签都不给 → 硬约束失败" {
  let j = cq("判断这句话的情绪（正面/负面/中性）：「服务太差了。」", "这句话在抱怨服务质量。")
  assert_eq(cnum(j, "critical_failed"), 1.0)
  assert_eq(cstr(j, "gate"), "warn")
}

///|
test "S02 字数上限：19 字通过 / 40 字失败" {
  let p = "请用不超过30字概括：随着5G网络的普及，物联网设备数量激增……"
  let ok = cq(p, "5G推动万物互联，物联网应用加速落地。")
  assert_eq(cstr(ok, "gate"), "pass")
  let bad = cq(
    p,
    "随着5G网络的普及，物联网设备的数量正在快速增长，智能家居和智慧城市等应用场景不断落地，我们正在进入万物互联的时代。",
  )
  assert_eq(cstr(bad, "gate"), "warn")
  assert_eq(cnum(bad, "critical_failed"), 1.0)
}

///|
test "W02 句数：微调只写 1 句（要求 3 句）→ 门禁 warn 且封顶 3.5" {
  let p = "用3句话写一个关于「坚持」的小故事，要有转折。"
  let j = cq(p, "他每天坚持练习，直到第四十天，那首曲子竟在他指尖流淌成歌。")
  assert_eq(cstr(j, "gate"), "warn")
  assert_eq(cnum(j, "gated_total") <= 3.5, true)
}

///|
test "W02 句数：三句话通过" {
  let p = "用3句话写一个关于「坚持」的小故事，要有转折。"
  let j = cq(
    p,
    "小明每天坚持练习钢琴。一次演出他紧张忘词，琴声戛然而止。但他重新站上舞台，掌声雷动。",
  )
  assert_eq(cstr(j, "gate"), "pass")
}

///|
test "C03 代码：裸函数定义也算给出代码；纯文字讲解不算" {
  let p = "用 Python 写一个函数，把字符串反转。"
  let ok = cq(p, "def reverse_string(s): return s[::-1]")
  assert_eq(cstr(ok, "gate"), "pass")
  let bad = cq(p, "可以使用切片操作来实现字符串反转，具体做法是从后往前取。")
  assert_eq(cstr(bad, "gate"), "warn")
}

///|
test "R02 两步：只给结论没判断前提 → 硬约束失败" {
  let p = "所有鸟都会飞。企鹅是鸟。企鹅会飞吗？请先判断这句话的前提是否正确，再回答。"
  let bad = cq(p, "企鹅会飞。")
  assert_eq(cstr(bad, "gate"), "warn")
  let ok = cq(p, "前提不正确：并非所有鸟都会飞，企鹅是鸟但企鹅不会飞。")
  assert_eq(cstr(ok, "gate"), "pass")
}

///|
test "通用软约束：套话开场只扣约束分，不触发门禁" {
  let j = cq("水的化学式是什么？", "当然可以！水的化学式是 H2O。")
  assert_eq(cstr(j, "gate"), "pass")
  assert_eq(cnum(j, "critical_failed"), 0.0)
  assert_true(cnum(j, "constraint") < 5.0)
}

///|
test "空答案：硬约束全灭 → fail 且 gated_total 封顶 2.0" {
  let m : Map[String, Json] = Map([], capacity=4)
  m["prompt"] = Json::string("请用不超过30字概括：远程办公在疫情后成为常态。")
  m["answer"] = Json::string("")
  m["reference"] = Json::string("远程办公成为常态，利弊并存")
  m["task_type"] = Json::string("文本摘要")
  let j = cparse(eval_engine(Json::object(m).stringify()))
  assert_eq(cstr(j, "gate"), "fail")
  assert_true(cnum(j, "gated_total") <= 2.0)
  assert_true(cnum(j, "total") >= 0.0)
}

///|
test "门禁不改变 total：只额外给出 constraint 与 gated_total" {
  let m : Map[String, Json] = Map([], capacity=4)
  m["prompt"] = Json::string("用3句话写一个关于「坚持」的小故事，要有转折。")
  m["answer"] = Json::string("他坚持了四十年。")
  m["reference"] = Json::string("坚持 转折 故事")
  m["task_type"] = Json::string("创意写作")
  let j = cparse(eval_engine(Json::object(m).stringify()))
  assert_eq(cstr(j, "gate"), "warn")
  // total 是五维均分，不受门禁影响；gated_total 才是封顶后的分
  assert_true(cnum(j, "total") >= cnum(j, "gated_total"))
  assert_eq(cnum(j, "gated_total") <= 3.5, true)
}
