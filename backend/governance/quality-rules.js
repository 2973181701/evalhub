/**
 * EvalHub · 数据质量规则集（服务端 seed，规则即数据）
 *
 * 统一约定：check_sql 返回单行单列 `violations`（整数），0 = 通过。
 * severity='warning' 的规则只做趋势提示，不进入质量分、不触发阻断。
 *
 * 每条规则都对应一个真实踩过的坑或一条硬约束：
 *   run_progress_bounds —— 之前 ids 过滤没落库，出现「进度 20/3」；
 *   label_split_leakage —— 留出集若同题跨侧，κ 直接失真；
 *   annotations_choice_enum —— 中文「平手」曾被误建成英文 tie；
 *   rubric_weight_sum —— 口径权重和必须为 1，注册时已校验，这里做兜底巡检。
 */

export const DQ_RULES = [
  {
    key: 'dataset_items_unique',
    category: '唯一性',
    severity: 'critical',
    description: '同一数据集版本内题号不得重复',
    check_sql: `SELECT count(*)::int AS violations FROM (
      SELECT dataset_id, item_key FROM dataset_items GROUP BY 1,2 HAVING count(*) > 1
    ) x`,
  },
  {
    key: 'dataset_hash_unique',
    category: '唯一性',
    severity: 'critical',
    description: '同一数据集名称下内容哈希不得重复（防重复建版本）',
    check_sql: `SELECT count(*)::int AS violations FROM (
      SELECT name, content_hash FROM datasets GROUP BY 1,2 HAVING count(*) > 1
    ) x`,
  },
  {
    key: 'run_progress_bounds',
    category: '一致性',
    severity: 'critical',
    description: '评测进度不得超过总题数（防止出现 20/3 这类越界进度）',
    check_sql: `SELECT count(*)::int AS violations FROM eval_runs
      WHERE done_items > total_items OR failed_items > total_items
         OR done_items < 0 OR failed_items < 0`,
  },
  {
    key: 'run_status_valid',
    category: '枚举',
    severity: 'critical',
    description: 'run 状态必须在约定枚举内',
    check_sql: `SELECT count(*)::int AS violations FROM eval_runs
      WHERE status NOT IN ('queued','running','succeeded','failed','canceled')`,
  },
  {
    key: 'results_orphan_run',
    category: '引用完整性',
    severity: 'critical',
    description: '评测结果不得指向不存在的 run',
    check_sql: `SELECT count(*)::int AS violations FROM eval_results e
      WHERE NOT EXISTS (SELECT 1 FROM eval_runs r WHERE r.id = e.run_id)`,
  },
  {
    key: 'results_duplicate_item',
    category: '唯一性',
    severity: 'critical',
    description: '同一次 run 里同一题号不得有两条结果',
    check_sql: `SELECT count(*)::int AS violations FROM (
      SELECT run_id, item_key FROM eval_results GROUP BY 1,2 HAVING count(*) > 1
    ) x`,
  },
  {
    key: 'annotations_choice_enum',
    category: '枚举',
    severity: 'critical',
    description: '标注 choice 只能是 A / B / 平手（中文平手不可翻成 tie）',
    check_sql: `SELECT count(*)::int AS violations FROM annotations
      WHERE choice NOT IN ('A','B','平手')`,
  },
  {
    key: 'annotations_confidence_range',
    category: '范围',
    severity: 'critical',
    description: '置信度必须在 1-5 或为空',
    check_sql: `SELECT count(*)::int AS violations FROM annotations
      WHERE confidence IS NOT NULL AND (confidence < 1 OR confidence > 5)`,
  },
  {
    key: 'label_annotations_source',
    category: '枚举',
    severity: 'critical',
    description: '标签来源只能是 human 或 test_fixture（防止伪造金标准）',
    check_sql: `SELECT count(*)::int AS violations FROM label_annotations
      WHERE label_source NOT IN ('human','test_fixture')`,
  },
  {
    key: 'label_split_leakage',
    category: '一致性',
    severity: 'critical',
    description: '同一题目不得同时出现在 train 与 test（留出集泄漏红线）',
    check_sql: `SELECT count(*)::int AS violations FROM (
      SELECT source_prompt_id FROM label_pairs
      GROUP BY source_prompt_id
      HAVING count(DISTINCT split) > 1
    ) x`,
  },
  {
    key: 'rubric_single_active',
    category: '唯一性',
    severity: 'critical',
    description: '每个口径 key 最多一个生效版本',
    check_sql: `SELECT count(*)::int AS violations FROM (
      SELECT key FROM rubrics WHERE is_active GROUP BY key HAVING count(*) > 1
    ) x`,
  },
  {
    key: 'rubric_weight_sum',
    category: '一致性',
    severity: 'critical',
    description: '口径维度权重和必须为 1',
    check_sql: `SELECT count(*)::int AS violations FROM rubrics r
      WHERE abs(coalesce((
        SELECT sum((d->>'weight')::numeric) FROM jsonb_array_elements(r.dimensions) d
      ), 0) - 1) > 0.001`,
  },
  {
    key: 'run_freshness',
    category: '新鲜度',
    severity: 'warning',
    description: '最近 7 天是否有新的评测任务（趋势提示，不计分）',
    check_sql: `SELECT (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END)::int AS violations
      FROM eval_runs WHERE created_at > now() - interval '7 days'`,
  },
  {
    key: 'label_test_coverage',
    category: '完整性',
    severity: 'warning',
    description: '留出集 test 是否已有真人标签（提示标注进度，不计分）',
    check_sql: `SELECT (CASE WHEN count(*) = 0 THEN 1 ELSE 0 END)::int AS violations
      FROM label_pairs p JOIN label_annotations a ON a.pair_id = p.id
      WHERE p.split = 'test' AND a.label_source = 'human'`,
  },
];
