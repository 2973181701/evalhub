///|
/// EvalHub 核心引擎包。
///
/// 阶段 0 只提供版本信息作为「骨架连通性自检」；
/// 阶段 1–3 会在此包内扩展四个引擎：
///   - engine_eval.mbt      评测引擎（5 维评分）
///   - engine_annotate.mbt  标注引擎（A/B 偏好校验）
///   - engine_analyze.mbt   分析引擎（均分 / 一致性 / 雷达图）
///   - engine_data.mbt      数据引擎（RLHF 导出）
///
/// 约定：所有对外函数都是「纯函数」——输入 JSON 字符串，输出 JSON 字符串。
pub fn version() -> String {
  "EvalHub core 0.1.0"
}
