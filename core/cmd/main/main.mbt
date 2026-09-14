///|
/// EvalHub core CLI 入口。
/// 运行：`moon run cmd/main`（在 core/ 目录下）
///
/// 作用：不依赖 Node、不依赖浏览器，纯 MoonBit 侧自检四个引擎的 JSON 边界，
/// 顺带把每个引擎的输入输出契约打印出来，方便肉眼核对。
fn main {
  println("==================================================")
  println("  EvalHub core 自检 —— 四引擎 JSON 边界")
  println("==================================================")
  println(@engine.version())
  println("")

  // ① 评测引擎：好回答 vs 跑题回答
  println("[1/4] 评测引擎 eval_engine")
  println(
    "  好回答（K01 北京）  → " +
    @engine.eval_engine(
      "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"中国的首都是北京。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
    ),
  )
  println(
    "  跑题回答（同题）    → " +
    @engine.eval_engine(
      "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"今天天气真不错，适合出去玩。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
    ),
  )
  println("  非法 JSON           → " + @engine.eval_engine("{bad json"))
  println("")

  // ② 标注引擎：合法 / 非法 / 质检标记
  println("[2/4] 标注引擎 annotate_engine")
  println(
    "  合法标注            → " +
    @engine.annotate_engine(
      "{\"id\":\"K01\",\"answer_A\":\"北京\",\"answer_B\":\"中国的首都是北京，北京是政治文化中心。\",\"choice\":\"A\",\"reason\":\"选 A：依据维度 5 表达质量，A 直接给出答案，B 冗余。\",\"confidence\":5}",
    ),
  )
  println(
    "  非法 choice+越界    → " +
    @engine.annotate_engine(
      "{\"id\":\"K02\",\"answer_A\":\"甲\",\"answer_B\":\"乙\",\"choice\":\"C\",\"reason\":\"随便选\",\"confidence\":9}",
    ),
  )
  println("")

  // ③ 分析引擎：均分 / 雷达图 / 需复核样本
  println("[3/4] 分析引擎 analyze_engine")
  println(
    "  三条构造样本        → " +
    @engine.analyze_engine(
      "{\"scores\":[" +
      "{\"id\":\"T1\",\"task_type\":\"事实问答\",\"accuracy\":5,\"completeness\":4,\"logic\":3,\"safety\":2,\"expression\":1,\"total\":3}," +
      "{\"id\":\"T2\",\"task_type\":\"事实问答\",\"accuracy\":1,\"completeness\":1,\"logic\":1,\"safety\":1,\"expression\":1,\"total\":1}," +
      "{\"id\":\"T3\",\"task_type\":\"逻辑推理\",\"accuracy\":3,\"completeness\":3,\"logic\":3,\"safety\":3,\"expression\":3,\"total\":3}]}",
    ),
  )
  println("")

  // ④ 一致性引擎 + 数据引擎
  println("[4/4] 一致性引擎 consistency_engine / 数据引擎 export_rlhf")
  println(
    "  2 人 4 条（3 一致） → " +
    @engine.consistency_engine(
      "{\"records\":[" +
      "{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I1\",\"annotator\":\"llm\",\"choice\":\"A\"}," +
      "{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"llm\",\"choice\":\"A\"}," +
      "{\"id\":\"I3\",\"annotator\":\"human\",\"choice\":\"B\"},{\"id\":\"I3\",\"annotator\":\"llm\",\"choice\":\"B\"}," +
      "{\"id\":\"I4\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I4\",\"annotator\":\"llm\",\"choice\":\"B\"}]}",
    ),
  )
  println(
    "  单人标注（κ=null）  → " +
    @engine.consistency_engine(
      "{\"records\":[{\"id\":\"I1\",\"annotator\":\"human\",\"choice\":\"A\"},{\"id\":\"I2\",\"annotator\":\"human\",\"choice\":\"B\"}]}",
    ),
  )
  println(
    "  RLHF 导出（A/B/平手）→ " +
    @engine.export_rlhf(
      "{\"annotations\":[" +
      "{\"id\":\"K01\",\"task_type\":\"事实问答\",\"prompt\":\"中国的首都是哪个城市？\",\"answer_A\":\"北京\",\"answer_B\":\"中国的首都是北京（长版）\",\"choice\":\"A\"}," +
      "{\"id\":\"R02\",\"task_type\":\"逻辑推理\",\"prompt\":\"企鹅会飞吗？\",\"answer_A\":\"会飞\",\"answer_B\":\"不会飞\",\"choice\":\"B\"}," +
      "{\"id\":\"S02\",\"task_type\":\"文本摘要\",\"prompt\":\"概括 5G\",\"answer_A\":\"万物互联\",\"answer_B\":\"万物互联\",\"choice\":\"平手\"}]}",
    ),
  )
  println("")
  println("==================================================")
  println("  自检完成：四引擎均可调用，非法输入均被兜底")
  println("==================================================")
}
