///|
/// 数据引擎单测（whitebox，同包直调）
/// 用例覆盖：A / B / 平手 三种 choice + 三类丢弃原因 + 两种输出格式
/// 数据取自真实 A/B 标注数据 pairs.json（K01 / S02 / R04）

///|
/// 真实样本（pairs.json 原文，截断到可读长度）
fn sample_annotations() -> String {
  "{\"annotations\":[" +
  "{\"id\":\"K01\",\"task_type\":\"事实问答\",\"prompt\":\"中国的首都是哪个城市？\",\"answer_A\":\"北京\",\"answer_B\":\"中国的首都是北京，北京是政治文化中心。\",\"choice\":\"A\",\"reason\":\"选 A：依据维度 5，A 更简洁。\",\"confidence\":5}," +
  "{\"id\":\"R02\",\"task_type\":\"逻辑推理\",\"prompt\":\"企鹅会飞吗？\",\"answer_A\":\"前提正确，企鹅会飞。\",\"answer_B\":\"前提不成立，企鹅不会飞。\",\"choice\":\"B\",\"reason\":\"选 B：依据维度 1 事实准确性，A 事实错误。\",\"confidence\":5}," +
  "{\"id\":\"S02\",\"task_type\":\"文本摘要\",\"prompt\":\"请用一句话概括 5G 的意义。\",\"answer_A\":\"5G推动物联网发展，万物互联时代来临。\",\"answer_B\":\"5G推动物联网发展，万物互联时代来临。\",\"choice\":\"平手\",\"reason\":\"平手：两回答文本完全相同。\",\"confidence\":5}," +
  "{\"id\":\"X01\",\"task_type\":\"事实问答\",\"prompt\":\"测试非法 choice\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"C\",\"reason\":\"选 C 因为随便选。\",\"confidence\":3}," +
  "{\"id\":\"X02\",\"task_type\":\"事实问答\",\"prompt\":\"\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"A\",\"reason\":\"选 A 因为简洁。\",\"confidence\":3}" +
  "]}"
}

///|
test "RLHF 导出：choice=A → chosen=answer_A，rejected=answer_B" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"K01\",\"task_type\":\"事实问答\",\"prompt\":\"中国的首都是哪个城市？\",\"answer_A\":\"北京\",\"answer_B\":\"中国的首都是北京，北京是政治文化中心。\",\"choice\":\"A\"}]}",
    ),
  )
  let data = t_arr(j, "data")
  assert_eq(t_len(data), 1)
  let item = data[0]
  assert_eq(t_str(item, "prompt"), "中国的首都是哪个城市？")
  assert_eq(t_str(item, "chosen"), "北京")
  assert_eq(
    t_str(item, "rejected"),
    "中国的首都是北京，北京是政治文化中心。",
  )
  assert_eq(t_str(item, "id"), "K01")
}

///|
test "RLHF 导出：choice=B → chosen 与 rejected 对调" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"R02\",\"task_type\":\"逻辑推理\",\"prompt\":\"企鹅会飞吗？\",\"answer_A\":\"前提正确，企鹅会飞。\",\"answer_B\":\"前提不成立，企鹅不会飞。\",\"choice\":\"B\"}]}",
    ),
  )
  let item = t_arr(j, "data")[0]
  assert_eq(t_str(item, "chosen"), "前提不成立，企鹅不会飞。")
  assert_eq(t_str(item, "rejected"), "前提正确，企鹅会飞。")
}

///|
test "RLHF 导出：平手 → 丢弃，不计入 data 但计入 dropped_detail.tie" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"S02\",\"task_type\":\"文本摘要\",\"prompt\":\"概括 5G 意义\",\"answer_A\":\"万物互联\",\"answer_B\":\"万物互联时代\",\"choice\":\"平手\"}]}",
    ),
  )
  assert_eq(t_len(t_arr(j, "data")), 0)
  assert_eq(t_num(j, "exported"), 0.0)
  assert_eq(t_num(j, "dropped"), 1.0)
  assert_eq(t_num(t_obj(j, "dropped_detail"), "tie"), 1.0)
}

///|
test "RLHF 导出：非法 choice → 计入 invalid_choice，不进 data" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"X01\",\"prompt\":\"p\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"C\"}]}",
    ),
  )
  assert_eq(t_len(t_arr(j, "data")), 0)
  assert_eq(t_num(t_obj(j, "dropped_detail"), "invalid_choice"), 1.0)
}

///|
test "RLHF 导出：缺 prompt → 计入 missing_answer" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"X02\",\"prompt\":\"\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_len(t_arr(j, "data")), 0)
  assert_eq(t_num(t_obj(j, "dropped_detail"), "missing_answer"), 1.0)
}

///|
test "RLHF 导出：chosen 与 rejected 文本相同 → 计入 identical（零信息样本）" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"X03\",\"prompt\":\"p\",\"answer_A\":\"一样\",\"answer_B\":\"一样\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_len(t_arr(j, "data")), 0)
  assert_eq(t_num(t_obj(j, "dropped_detail"), "identical"), 1.0)
}

///|
test "RLHF 导出：混合 5 条真实样本 → exported=2, dropped=3，计数逐项对得上" {
  let j = t_parse(export_rlhf(sample_annotations()))
  assert_eq(t_num(j, "total"), 5.0)
  assert_eq(t_num(j, "exported"), 2.0)
  assert_eq(t_num(j, "dropped"), 3.0)
  let d = t_obj(j, "dropped_detail")
  assert_eq(t_num(d, "tie"), 1.0)
  assert_eq(t_num(d, "invalid_choice"), 1.0)
  assert_eq(t_num(d, "missing_answer"), 1.0)
  assert_eq(t_num(d, "identical"), 0.0)
}

///|
test "RLHF 导出：format=openai → 输出 messages / chosen / rejected 三段对话结构" {
  let j = t_parse(
    export_rlhf(
      "{\"format\":\"openai\",\"annotations\":[{\"id\":\"K01\",\"prompt\":\"中国的首都是哪个城市？\",\"answer_A\":\"北京\",\"answer_B\":\"北京（长版）\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_str(j, "format"), "openai")
  let item = t_arr(j, "data")[0]
  let msgs = t_arr(item, "messages")
  assert_eq(t_len(msgs), 1)
  assert_eq(t_str(msgs[0], "role"), "user")
  assert_eq(t_str(msgs[0], "content"), "中国的首都是哪个城市？")
  let chosen = t_arr(item, "chosen")
  assert_eq(t_str(chosen[0], "role"), "assistant")
  assert_eq(t_str(chosen[0], "content"), "北京")
}

///|
test "RLHF 导出：缺省 format → 默认 dpo" {
  let j = t_parse(
    export_rlhf(
      "{\"annotations\":[{\"id\":\"K01\",\"prompt\":\"p\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_str(j, "format"), "dpo")
}

///|
test "RLHF 导出：annotations 为空数组 → 全 0，不报错" {
  let j = t_parse(export_rlhf("{\"annotations\":[]}"))
  assert_eq(t_num(j, "total"), 0.0)
  assert_eq(t_num(j, "exported"), 0.0)
  assert_eq(t_len(t_arr(j, "data")), 0)
}

///|
test "非法 JSON 输入：数据引擎返回 error 字段且不向宿主抛错" {
  let out = export_rlhf("not-a-json")
  assert_true(contains_str(out, "invalid_json"))
}

///|
/// 测试辅助：取嵌套对象字段
fn t_obj(j : Json, key : String) -> Json {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(v) => v
        _ => Json::null()
      }
    _ => Json::null()
  }
}
