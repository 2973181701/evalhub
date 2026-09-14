///|
/// 分析引擎 · 统计 / 一致性 / 雷达图 / 争议样本（纯函数，JSON in → JSON out）
///
/// 两个对外入口：
///   analyze_engine      —— 一批评分结果 → 五维均分 / 雷达图 / 分题型统计 / 需复核样本
///   consistency_engine  —— 多人标注记录 → 成对一致率 / 全票一致率 / Fleiss' κ / 争议条目
///
/// 设计原则：引擎不猜数据。样本字段缺失就跳过并计数（skipped），
/// 一致性样本不足就返回 null 并给出原因（kappa_note），绝不编一个数字出来。

///|
/// ===================== 入口 1：评分统计 =====================

///|
/// 输入
/// { "scores": [ { "id":"K01", "task_type":"事实问答",
///                 "accuracy":5, "completeness":5, "logic":2,
///                 "safety":5, "expression":3.5, "total":4.1 } ] }
/// 输出
/// {
///   "count": 20, "skipped": 0,
///   "dimensions": { "accuracy":4.2, "completeness":4.0, ... },
///   "total": 3.9,
///   "radar": [ { "key":"accuracy", "label":"准确性", "value":4.2, "ratio":0.84 } ],
///   "by_task_type": [ { "task_type":"事实问答", "count":4, "total":4.1 } ],
///   "lowest_total": [ { "id":"R04", "task_type":"逻辑推理", "total":1.8 } ],
///   "max_spread":   [ { "id":"R04", "task_type":"逻辑推理", "spread":3.5 } ]
/// }
pub fn analyze_engine(input : String) -> String {
  let j = @json.parse(input) catch { _ => return error_json("invalid_json") }
  let scores = get_arr(j, "scores")
  let keys = dim_keys()
  let labels = dim_labels()
  let dim_count = keys.length()

  let sums : Array[Double] = []
  let mut k = 0
  while k < dim_count {
    sums.push(0.0)
    k = k + 1
  }

  let stats : Array[SampleStat] = []
  let task_names : Array[String] = []
  let task_counts : Array[Int] = []
  let task_totals : Array[Double] = []
  let mut total_sum = 0.0
  let mut skipped = 0

  for s in scores {
    let dims : Array[Double] = []
    let mut ok = true
    let mut i = 0
    while i < dim_count {
      match get_num_field(s, keys[i]) {
        Some(v) => dims.push(v)
        None => ok = false
      }
      i = i + 1
    }
    if !ok || dims.length() != dim_count {
      skipped = skipped + 1
    } else {
      let mut hi = dims[0]
      let mut lo = dims[0]
      let mut sum = 0.0
      let mut n = 0
      while n < dim_count {
        sums[n] = sums[n] + dims[n]
        if dims[n] > hi {
          hi = dims[n]
        }
        if dims[n] < lo {
          lo = dims[n]
        }
        sum = sum + dims[n]
        n = n + 1
      }
      let total = match get_num_field(s, "total") {
        Some(t) => t
        None => sum / Double::from_int(dim_count)
      }
      total_sum = total_sum + total
      let task_type = get_str(s, "task_type")
      stats.push({ id: get_str(s, "id"), task_type, total, spread: hi - lo, })
      // 分题型聚合（保持首次出现顺序，输出稳定）
      let idx = index_of_str(task_names, task_type)
      if idx < 0 {
        task_names.push(task_type)
        task_counts.push(1)
        task_totals.push(total)
      } else {
        task_counts[idx] = task_counts[idx] + 1
        task_totals[idx] = task_totals[idx] + total
      }
    }
  }

  let count = stats.length()
  let cn = Double::from_int(count)

  let dimensions : Map[String, Json] = Map([], capacity=8)
  let radar : Array[Json] = []
  let mut i = 0
  while i < dim_count {
    let mean = if count == 0 { 0.0 } else { round2(sums[i] / cn) }
    dimensions[keys[i]] = Json::number(mean)
    radar.push(radar_point(keys[i], labels[i], mean))
    i = i + 1
  }

  let by_task : Array[Json] = []
  let mut t = 0
  while t < task_names.length() {
    let tm : Map[String, Json] = Map([], capacity=4)
    tm["task_type"] = Json::string(task_names[t])
    tm["count"] = Json::number(Double::from_int(task_counts[t]))
    tm["total"] = Json::number(
      round2(task_totals[t] / Double::from_int(task_counts[t])),
    )
    by_task.push(Json::object(tm))
    t = t + 1
  }

  let m : Map[String, Json] = Map([], capacity=16)
  m["count"] = Json::number(cn)
  m["skipped"] = Json::number(Double::from_int(skipped))
  m["dimensions"] = Json::object(dimensions)
  m["total"] = Json::number(
    if count == 0 {
      0.0
    } else {
      round2(total_sum / cn)
    },
  )
  m["radar"] = Json::array(radar)
  m["by_task_type"] = Json::array(by_task)
  m["lowest_total"] = Json::array(pick_samples(stats, "total", false))
  m["max_spread"] = Json::array(pick_samples(stats, "spread", true))
  Json::object(m).stringify()
}

///|
/// 单条样本的聚合视图
priv struct SampleStat {
  id : String
  task_type : String
  total : Double
  spread : Double
}

///|
fn radar_point(key : String, label : String, value : Double) -> Json {
  let m : Map[String, Json] = Map([], capacity=8)
  m["key"] = Json::string(key)
  m["label"] = Json::string(label)
  m["value"] = Json::number(value)
  m["ratio"] = Json::number(round2(value / 5.0))
  Json::object(m)
}

///|
/// 挑出最需要注意的样本（最多 5 条）：
///   field = "total"  → 总分最低（最该人工复核）
///   field = "spread" → 五维极差最大（引擎自己都拿不准，规则冲突的信号）
fn pick_samples(
  stats : Array[SampleStat],
  field : String,
  desc : Bool,
) -> Array[Json] {
  let picked : Array[Int] = []
  let limit = if stats.length() < 5 { stats.length() } else { 5 }
  let mut round = 0
  while round < limit {
    let mut best = -1
    let mut best_val = 0.0
    let mut i = 0
    while i < stats.length() {
      if !array_contains_int(picked, i) {
        let v = if field == "total" { stats[i].total } else { stats[i].spread }
        let better = if best < 0 {
          true
        } else if desc {
          v > best_val
        } else {
          v < best_val
        }
        if better {
          best = i
          best_val = v
        }
      }
      i = i + 1
    }
    if best >= 0 {
      picked.push(best)
    }
    round = round + 1
  }
  let out : Array[Json] = []
  for idx in picked {
    let m : Map[String, Json] = Map([], capacity=8)
    m["id"] = Json::string(stats[idx].id)
    m["task_type"] = Json::string(stats[idx].task_type)
    if field == "total" {
      m["total"] = Json::number(stats[idx].total)
    } else {
      m["spread"] = Json::number(round2(stats[idx].spread))
    }
    out.push(Json::object(m))
  }
  out
}

///|
/// ===================== 入口 2：标注一致性 =====================

///|
/// 输入
/// { "records": [ { "id":"K01", "annotator":"human", "choice":"A" },
///                { "id":"K01", "annotator":"llm_judge", "choice":"A" } ] }
/// 输出
/// {
///   "annotators": ["human","llm_judge"],
///   "items_rated": 20, "items_complete": 20, "skipped": 0,
///   "pairwise_agreement": 0.85,
///   "unanimous_rate": 0.85,
///   "fleiss_kappa": 0.62,          // null = 样本不足，见 kappa_note
///   "kappa_note": "",
///   "disputed_items": ["R04", ...]
/// }
///
/// 指标定义（面试可讲）：
///   成对一致率 = 所有标注者两两配对中「选同一个」的比例
///   全票一致率 = 全体标注者完全一致的条目占比
///   Fleiss' κ   = (P̄ − P_e) / (1 − P_e)，扣除「瞎猜也会撞上」的偶然一致
pub fn consistency_engine(input : String) -> String {
  let j = @json.parse(input) catch { _ => return error_json("invalid_json") }
  let records = get_arr(j, "records")
  let annotators : Array[String] = []
  let item_ids : Array[String] = []
  let table : Map[String, Map[String, String]] = Map([], capacity=64)
  let mut skipped = 0

  for r in records {
    let id = get_str(r, "id")
    let who = get_str(r, "annotator")
    let choice = normalize_choice(get_str(r, "choice"))
    if id == "" || who == "" || choice == "" {
      skipped = skipped + 1
    } else {
      if !array_contains_str(annotators, who) {
        annotators.push(who)
      }
      match table.get(id) {
        Some(inner) => inner[who] = choice
        None => {
          let inner : Map[String, String] = Map([], capacity=8)
          inner[who] = choice
          table[id] = inner
          item_ids.push(id)
        }
      }
    }
  }

  let cats = choice_cats()
  let mut total_pairs = 0
  let mut agree_pairs = 0
  let mut unanimous = 0
  let mut complete_n = 0
  let mut sum_pi = 0.0
  let cat_totals : Array[Double] = []
  let mut c = 0
  while c < cats.length() {
    cat_totals.push(0.0)
    c = c + 1
  }
  let disputed : Array[String] = []

  for id in item_ids {
    let inner = match table.get(id) {
      Some(v) => v
      None => Map([], capacity=1)
    }
    let choices : Array[String] = []
    for a in annotators {
      match inner.get(a) {
        Some(ch) => choices.push(ch)
        None => ()
      }
    }
    let m = choices.length()
    // 成对一致
    let mut i = 0
    while i < m {
      let mut j = i + 1
      while j < m {
        total_pairs = total_pairs + 1
        if choices[i] == choices[j] {
          agree_pairs = agree_pairs + 1
        }
        j = j + 1
      }
      i = i + 1
    }
    // 全票一致
    let mut all_same = m > 0
    let mut p = 1
    while p < m {
      if choices[p] != choices[0] {
        all_same = false
      }
      p = p + 1
    }
    if all_same {
      unanimous = unanimous + 1
    } else {
      disputed.push(id)
    }
    // Fleiss' κ 只用「被全部标注者标注过」的条目（每行评分人数必须相等）
    if m == annotators.length() && annotators.length() >= 2 {
      complete_n = complete_n + 1
      let n = Double::from_int(m)
      let mut sq = 0.0
      let mut k = 0
      while k < cats.length() {
        let mut cnt = 0.0
        for ch in choices {
          if ch == cats[k] {
            cnt = cnt + 1.0
          }
        }
        sq = sq + cnt * cnt
        cat_totals[k] = cat_totals[k] + cnt
        k = k + 1
      }
      sum_pi = sum_pi + (sq - n) / (n * (n - 1.0))
    }
  }

  let items_rated = item_ids.length()
  let pairwise = if total_pairs == 0 {
    0.0
  } else {
    round4(Double::from_int(agree_pairs) / Double::from_int(total_pairs))
  }
  let unanimous_rate = if items_rated == 0 {
    0.0
  } else {
    round4(Double::from_int(unanimous) / Double::from_int(items_rated))
  }

  // κ：样本不足时返回 null，并给出原因（不编数字）
  let (kappa, note) = kappa_of(
    complete_n,
    annotators.length(),
    sum_pi,
    cat_totals,
    cats.length(),
  )

  let ann_json : Array[Json] = []
  for a in annotators {
    ann_json.push(Json::string(a))
  }
  let dis_json : Array[Json] = []
  for d in disputed {
    dis_json.push(Json::string(d))
  }

  let m : Map[String, Json] = Map([], capacity=16)
  m["annotators"] = Json::array(ann_json)
  m["items_rated"] = Json::number(Double::from_int(items_rated))
  m["items_complete"] = Json::number(Double::from_int(complete_n))
  m["skipped"] = Json::number(Double::from_int(skipped))
  m["pairwise_agreement"] = Json::number(pairwise)
  m["unanimous_rate"] = Json::number(unanimous_rate)
  m["fleiss_kappa"] = match kappa {
    Some(k) => Json::number(round4(k))
    None => Json::null()
  }
  m["kappa_note"] = Json::string(note)
  m["disputed_items"] = Json::array(dis_json)
  Json::object(m).stringify()
}

///|
/// Fleiss' κ 计算 + 样本不足时的原因说明
fn kappa_of(
  complete_n : Int,
  annotator_count : Int,
  sum_pi : Double,
  cat_totals : Array[Double],
  cat_count : Int,
) -> (Double?, String) {
  if annotator_count < 2 {
    return (
      None,
      "只有 1 位标注者，一致性无从谈起（κ 需 ≥2 人）",
    )
  }
  if complete_n < 2 {
    return (
      None,
      "被全部标注者完整标注的样本不足 2 条，κ 无法稳定估计（当前 " +
      Double::from_int(complete_n).to_string() +
      " 条）",
    )
  }
  let n = Double::from_int(annotator_count)
  let big_n = Double::from_int(complete_n)
  let p_bar = sum_pi / big_n
  let mut p_e = 0.0
  let mut k = 0
  while k < cat_count {
    let pj = cat_totals[k] / (big_n * n)
    p_e = p_e + pj * pj
    k = k + 1
  }
  if 1.0 - p_e <= 0.0000001 {
    return (
      None,
      "所有标注者对所有样本的选择都落在同一类别，κ 无定义（P_e = 1）",
    )
  }
  (Some((p_bar - p_e) / (1.0 - p_e)), "")
}

///|
/// ===================== 以下为内部辅助（纯函数） =====================

///|
fn dim_keys() -> Array[String] {
  ["accuracy", "completeness", "logic", "safety", "expression"]
}

///|
fn dim_labels() -> Array[String] {
  ["准确性", "完整性", "逻辑性", "安全性", "表达质量"]
}

///|
/// 偏好标注的三个合法类别（顺序固定，保证输出稳定）
fn choice_cats() -> Array[String] {
  ["A", "B", "平手"]
}

///|
fn index_of_str(arr : Array[String], x : String) -> Int {
  let mut i = 0
  while i < arr.length() {
    if arr[i] == x {
      return i
    }
    i = i + 1
  }
  -1
}

///|
/// 一致性保留 4 位小数（κ 值精度比均分更重要；κ 可为负，需按符号取整）
fn round4(x : Double) -> Double {
  if x < 0.0 {
    -((-x * 10000.0 + 0.5).floor() / 10000.0)
  } else {
    (x * 10000.0 + 0.5).floor() / 10000.0
  }
}
