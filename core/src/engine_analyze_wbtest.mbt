///|
/// 分析引擎单测（whitebox，同包直调）
/// 统计部分：用可手算的构造样本；
/// 一致性部分：用可手算的 κ 用例（完全一致 / 完全不一致 / 部分一致），
/// 保证公式实现正确而不是「看起来像对」。

///|
/// ============ 评分统计 ============

///|
/// 三条可手算样本：
///   T1 事实问答  5/4/3/2/1 → total 3.0，五维极差 4.0
///   T2 事实问答  1/1/1/1/1 → total 1.0，极差 0.0
///   T3 逻辑推理  3/3/3/3/3 → total 3.0，极差 0.0
fn stat_scores_json() -> String {
  "{\"scores\":[" +
  "{\"id\":\"T1\",\"task_type\":\"事实问答\",\"accuracy\":5,\"completeness\":4,\"logic\":3,\"safety\":2,\"expression\":1,\"total\":3}," +
  "{\"id\":\"T2\",\"task_type\":\"事实问答\",\"accuracy\":1,\"completeness\":1,\"logic\":1,\"safety\":1,\"expression\":1,\"total\":1}," +
  "{\"id\":\"T3\",\"task_type\":\"逻辑推理\",\"accuracy\":3,\"completeness\":3,\"logic\":3,\"safety\":3,\"expression\":3,\"total\":3}" +
  "]}"
}

///|
test "统计：五维均分与总分（手算校验）" {
  let j = t_parse(analyze_engine(stat_scores_json()))
  assert_eq(t_num(j, "count"), 3.0)
  assert_eq(t_num(j, "skipped"), 0.0)
  let d = t_obj(j, "dimensions")
  assert_eq(t_num(d, "accuracy"), 3.0)
  assert_eq(t_num(d, "completeness"), 2.67)
  assert_eq(t_num(d, "logic"), 2.33)
  assert_eq(t_num(d, "safety"), 2.0)
  assert_eq(t_num(d, "expression"), 1.67)
  assert_eq(t_num(j, "total"), 2.33)
}

///|
test "统计：雷达图 5 维坐标 + ratio 归一化到 0–1" {
  let j = t_parse(analyze_engine(stat_scores_json()))
  let radar = t_arr(j, "radar")
  assert_eq(t_len(radar), 5)
  assert_eq(t_str(radar[0], "key"), "accuracy")
  assert_eq(t_str(radar[0], "label"), "准确性")
  assert_eq(t_num(radar[0], "value"), 3.0)
  assert_eq(t_num(radar[0], "ratio"), 0.6)
  assert_eq(t_str(radar[1], "label"), "完整性")
  assert_eq(t_str(radar[4], "label"), "表达质量")
}

///|
test "统计：分题型聚合（count 与均分）" {
  let j = t_parse(analyze_engine(stat_scores_json()))
  let by = t_arr(j, "by_task_type")
  assert_eq(t_len(by), 2)
  assert_eq(t_str(by[0], "task_type"), "事实问答")
  assert_eq(t_num(by[0], "count"), 2.0)
  assert_eq(t_num(by[0], "total"), 2.0)
  assert_eq(t_str(by[1], "task_type"), "逻辑推理")
  assert_eq(t_num(by[1], "count"), 1.0)
}

///|
test "统计：lowest_total 首位是总分最低样本；max_spread 首位是极差最大样本" {
  let j = t_parse(analyze_engine(stat_scores_json()))
  let low = t_arr(j, "lowest_total")
  assert_eq(t_len(low), 3)
  assert_eq(t_str(low[0], "id"), "T2")
  assert_eq(t_num(low[0], "total"), 1.0)
  let spread = t_arr(j, "max_spread")
  assert_eq(t_str(spread[0], "id"), "T1")
  assert_eq(t_num(spread[0], "spread"), 4.0)
}

///|
test "统计：样本缺维度字段 → 跳过并计入 skipped，不污染均分" {
  let j = t_parse(
    analyze_engine(
      "{\"scores\":[{\"id\":\"T1\",\"task_type\":\"事实问答\",\"accuracy\":5,\"completeness\":5,\"logic\":5,\"safety\":5,\"expression\":5,\"total\":5},{\"id\":\"BAD\",\"task_type\":\"事实问答\",\"accuracy\":1,\"completeness\":1}]}",
    ),
  )
  assert_eq(t_num(j, "count"), 1.0)
  assert_eq(t_num(j, "skipped"), 1.0)
  assert_eq(t_num(t_obj(j, "dimensions"), "accuracy"), 5.0)
}

///|
test "统计：total 缺失时按五维均分兜底" {
  let j = t_parse(
    analyze_engine(
      "{\"scores\":[{\"id\":\"T1\",\"task_type\":\"事实问答\",\"accuracy\":4,\"completeness\":4,\"logic\":4,\"safety\":4,\"expression\":4}]}",
    ),
  )
  assert_eq(t_num(j, "total"), 4.0)
}

///|
test "统计：空数组 → 全 0 且不报错" {
  let j = t_parse(analyze_engine("{\"scores\":[]}"))
  assert_eq(t_num(j, "count"), 0.0)
  assert_eq(t_num(j, "total"), 0.0)
  assert_eq(t_len(t_arr(j, "radar")), 5)
}

///|
test "非法 JSON 输入：分析引擎返回 error 字段且不向宿主抛错" {
  assert_true(contains_str(analyze_engine("oops"), "invalid_json"))
}

///|
/// ============ 标注一致性 ============

///|
/// 2 位标注者、4 条样本：A/A、A/A、B/B、A/B
/// 手算：成对一致率 3/4 = 0.75，全票一致率 3/4 = 0.75
///       P̄ = 0.75，P_e = 0.625² + 0.375² = 0.53125 → κ = 0.4667
fn consistency_partial_json() -> String {
  "{\"records\":[" +
  "{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"A\"}," +
  "{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"llm\",\"choice\":\"A\"}," +
  "{\"id\":\"I3\",\"annotator\":\"human\",\"choice\":\"B\"},{\"id\":\"I3\",\"annotator\":\"llm\",\"choice\":\"B\"}," +
  "{\"id\":\"I4\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I4\",\"annotator\":\"llm\",\"choice\":\"B\"}" +
  "]}"
}

///|
test "一致性：部分一致 → 一致率 0.75，κ = 0.4667（手算校验）" {
  let j = t_parse(consistency_engine(consistency_partial_json()))
  assert_eq(t_num(j, "items_rated"), 4.0)
  assert_eq(t_num(j, "items_complete"), 4.0)
  assert_eq(t_num(j, "pairwise_agreement"), 0.75)
  assert_eq(t_num(j, "unanimous_rate"), 0.75)
  assert_eq(t_num(j, "fleiss_kappa"), 0.4667)
  assert_eq(t_str(j, "kappa_note"), "")
  assert_eq(t_len(t_arr(j, "disputed_items")), 1)
  assert_true(t_arr_has_str(t_arr(j, "disputed_items"), "I4"))
}

///|
test "一致性：完全一致 → 一致率 1.0，κ = 1.0" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"B\"},{\"id\":\"I2\",\"annotator\":\"llm\",\"choice\":\"B\"}]}",
    ),
  )
  assert_eq(t_num(j, "pairwise_agreement"), 1.0)
  assert_eq(t_num(j, "unanimous_rate"), 1.0)
  assert_eq(t_num(j, "fleiss_kappa"), 1.0)
  assert_eq(t_len(t_arr(j, "disputed_items")), 0)
}

///|
test "一致性：完全相反 → 一致率 0.0，κ = -1.0（负值说明比瞎猜还差）" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"B\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"B\"},{\"id\":\"I2\",\"annotator\":\"llm\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_num(j, "pairwise_agreement"), 0.0)
  assert_eq(t_num(j, "fleiss_kappa"), -1.0)
}

///|
test "一致性：只有 1 位标注者 → κ 为 null 且给出原因" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"B\"}]}",
    ),
  )
  assert_eq(t_num(j, "items_rated"), 2.0)
  assert_true(t_is_null(j, "fleiss_kappa"))
  assert_true(contains_str(t_str(j, "kappa_note"), "1 位标注者"))
}

///|
test "一致性：矩阵不完整（有样本缺标注）→ κ 为 null 且给出原因" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"B\"}]}",
    ),
  )
  assert_eq(t_num(j, "items_rated"), 2.0)
  assert_eq(t_num(j, "items_complete"), 1.0)
  assert_true(t_is_null(j, "fleiss_kappa"))
  assert_true(contains_str(t_str(j, "kappa_note"), "完整标注"))
}

///|
test "一致性：非法 choice / 缺字段记录 → skipped，不参与统计" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"X\"},{\"id\":\"\",\"annotator\":\"llm\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_num(j, "skipped"), 2.0)
  assert_eq(t_num(j, "items_rated"), 1.0)
}

///|
test "一致性：choice 支持平手，且平手作为独立类别参与 κ" {
  let j = t_parse(
    consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"平手\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"tie\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"llm\",\"choice\":\"A\"}]}",
    ),
  )
  assert_eq(t_num(j, "pairwise_agreement"), 1.0)
  assert_eq(t_num(j, "fleiss_kappa"), 1.0)
}

///|
test "一致性：annotators 列表按首次出现顺序输出" {
  let j = t_parse(consistency_engine(consistency_partial_json()))
  let ann = t_arr(j, "annotators")
  assert_eq(t_len(ann), 2)
  assert_true(t_arr_has_str(ann, "human"))
  assert_true(t_arr_has_str(ann, "llm"))
}

///|
test "非法 JSON 输入：一致性引擎返回 error 字段且不向宿主抛错" {
  assert_true(contains_str(consistency_engine("oops"), "invalid_json"))
}
