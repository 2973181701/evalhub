///|
/// EvalHub core CLI 入口。
/// 运行：`moon run cmd/main`（在 core/ 目录下）
///
/// 自检：CLI 能编译、能引用 src 包、引擎 JSON 边界可用（含非法输入兜底）。
fn main {
  println("EvalHub core OK")
  println(@engine.version())
  println(@engine.eval_engine(
    "{\"prompt\":\"中国的首都是哪个城市？\",\"answer\":\"中国的首都是北京。\",\"reference\":\"北京\",\"task_type\":\"事实问答\"}",
  ))
  println(@engine.eval_engine("{bad json"))
}
