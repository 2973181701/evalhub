///|
/// 数据引擎 · RLHF 偏好训练集导出（纯函数，JSON in → JSON out）
///
/// 这是「AI 训练师」岗位的核心工作流：标注结果不能直接喂模型，
/// 必须转成统一的偏好数据格式（chosen / rejected 成对）。
///
/// 输入
/// {
///   "format": "dpo",                     // dpo（默认）| openai
///   "annotations": [
///     { "id":"K01", "task_type":"事实问答", "prompt":"...",
///       "answer_A":"...", "answer_B":"...", "choice":"A" }
///   ]
/// }
///
/// 输出
/// {
///   "total": 20, "exported": 18, "dropped": 2,
///   "dropped_detail": { "tie":2, "invalid_choice":0, "missing_answer":0, "identical":0 },
///   "data": [ { "id":"K01", "task_type":"事实问答", "prompt":"...",
///               "chosen":"...", "rejected":"..." } ]
/// }
///
/// 转换规则：
///   choice = A     → chosen = answer_A，rejected = answer_B
///   choice = B     → chosen = answer_B，rejected = answer_A
///   choice = 平手  → 丢弃（没有偏好信号，喂进去只会教坏模型）
///   choice 非法    → 丢弃并计数
///   缺 prompt/答案 → 丢弃并计数
///   chosen = rejected（两答案文本相同）→ 丢弃并计数（零信息样本）
///
/// 两种输出格式：
///   dpo    —— {prompt, chosen, rejected}，字符串形态，TRL/DPO 训练常用
///   openai —— 对话式 messages 形态，便于接入对话模型的偏好微调流程

///|
/// 对外入口：JSON 字符串进，JSON 字符串出。
pub fn export_rlhf(input : String) -> String {
  let j = @json.parse(input) catch { _ => return error_json("invalid_json") }
  let format = {
    let f = get_str(j, "format")
    if f == "openai" {
      "openai"
    } else {
      "dpo"
    }
  }
  let annotations = get_arr(j, "annotations")
  let data : Array[Json] = []
  let mut tie = 0
  let mut invalid_choice = 0
  let mut missing_answer = 0
  let mut identical = 0

  for a in annotations {
    let id = get_str(a, "id")
    let task_type = get_str(a, "task_type")
    let prompt = get_str(a, "prompt")
    let ans_a = get_str(a, "answer_A")
    let ans_b = get_str(a, "answer_B")
    let choice = normalize_choice(get_str(a, "choice"))
    if choice == "" {
      invalid_choice = invalid_choice + 1
    } else if choice == "平手" {
      tie = tie + 1
    } else if blank(prompt) || blank(ans_a) || blank(ans_b) {
      missing_answer = missing_answer + 1
    } else if ans_a == ans_b {
      identical = identical + 1
    } else {
      let (chosen, rejected) = if choice == "A" {
        (ans_a, ans_b)
      } else {
        (ans_b, ans_a)
      }
      if format == "openai" {
        data.push(openai_item(prompt, chosen, rejected))
      } else {
        data.push(dpo_item(id, task_type, prompt, chosen, rejected))
      }
    }
  }

  let detail : Map[String, Json] = Map([], capacity=8)
  detail["tie"] = Json::number(Double::from_int(tie))
  detail["invalid_choice"] = Json::number(Double::from_int(invalid_choice))
  detail["missing_answer"] = Json::number(Double::from_int(missing_answer))
  detail["identical"] = Json::number(Double::from_int(identical))

  let dropped = tie + invalid_choice + missing_answer + identical
  let m : Map[String, Json] = Map([], capacity=8)
  m["format"] = Json::string(format)
  m["total"] = Json::number(Double::from_int(annotations.length()))
  m["exported"] = Json::number(Double::from_int(data.length()))
  m["dropped"] = Json::number(Double::from_int(dropped))
  m["dropped_detail"] = Json::object(detail)
  m["data"] = Json::array(data)
  Json::object(m).stringify()
}

///|
/// ===================== 以下为内部辅助（纯函数） =====================

///|
/// DPO / TRL 形态：{prompt, chosen, rejected}
/// 额外带上 id 与 task_type 便于溯源（训练时可忽略这两列）
fn dpo_item(
  id : String,
  task_type : String,
  prompt : String,
  chosen : String,
  rejected : String,
) -> Json {
  let m : Map[String, Json] = Map([], capacity=8)
  m["id"] = Json::string(id)
  m["task_type"] = Json::string(task_type)
  m["prompt"] = Json::string(prompt)
  m["chosen"] = Json::string(chosen)
  m["rejected"] = Json::string(rejected)
  Json::object(m)
}

///|
/// 对话式 messages 形态：{messages:[user], chosen:[assistant], rejected:[assistant]}
fn openai_item(prompt : String, chosen : String, rejected : String) -> Json {
  let m : Map[String, Json] = Map([], capacity=4)
  m["messages"] = Json::array([role_msg("user", prompt)])
  m["chosen"] = Json::array([role_msg("assistant", chosen)])
  m["rejected"] = Json::array([role_msg("assistant", rejected)])
  Json::object(m)
}

///|
fn role_msg(role : String, content : String) -> Json {
  let m : Map[String, Json] = Map([], capacity=2)
  m["role"] = Json::string(role)
  m["content"] = Json::string(content)
  Json::object(m)
}

///|
fn get_arr(j : Json, key : String) -> Array[Json] {
  match j {
    Json::Object(m) =>
      match m.get(key) {
        Some(Json::Array(a)) => a
        _ => []
      }
    _ => []
  }
}
