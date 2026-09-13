///|
/// EvalHub core CLI 入口。
/// 运行：`moon run cmd/main`（在 core/ 目录下）
///
/// 阶段 0 的作用是「证明工具链打通」：能编译、能跑、能引用 src 包。
fn main {
  println("EvalHub core OK")
  println(@engine.version())
}
