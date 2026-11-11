-- EvalHub · 迁移 005：数据血缘与数据质量（数据中台治理层）
--
-- 为什么需要：评测中台解决「怎么评」，数据中台解决「凭什么信这些数据」。
-- 具体回答两个问题：
--   1. 报告里的 3.88 分，能追到哪个数据集版本 / 哪次 run / 哪份标注吗？（血缘）
--   2. 库里有没有脏数据、越界进度、留出集泄漏？（质量）
--
-- 设计约束：
--   1. lineage_edges 是**派生数据**，可随时从现有表重建，不是真相源；
--      lineage_events 才是无法从表关系推导的外部事件（接入、导出），rebuild 不清空它。
--   2. dq_rules 把规则当数据注册（口径可管），但规则 SQL 只由服务端 seed，
--      HTTP 不接受客户端自定义 SQL —— 否则等于开放任意查询。
--   3. dq_findings 保留每次检查的明细，使质量报告可复算、可对比历史趋势。

BEGIN;

-- ── 血缘 ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS lineage_edges (
  id          bigserial   PRIMARY KEY,
  src_type    text        NOT NULL,
  src_id      text        NOT NULL,
  dst_type    text        NOT NULL,
  dst_id      text        NOT NULL,
  relation    text        NOT NULL,
  metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  rebuilt_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_type, src_id, dst_type, dst_id, relation)
);

CREATE INDEX IF NOT EXISTS idx_lineage_src ON lineage_edges (src_type, src_id);
CREATE INDEX IF NOT EXISTS idx_lineage_dst ON lineage_edges (dst_type, dst_id);

-- 外部接入 / 报告导出等无法从表关系推导的边，由人工或脚本登记，rebuild 不清空
CREATE TABLE IF NOT EXISTS lineage_events (
  id          bigserial   PRIMARY KEY,
  src_type    text        NOT NULL,
  src_id      text        NOT NULL,
  dst_type    text        NOT NULL,
  dst_id      text        NOT NULL,
  relation    text        NOT NULL,
  note        text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (src_type, src_id, dst_type, dst_id, relation)
);

COMMENT ON TABLE lineage_edges IS
  '从现有表关系派生的血缘边，可由 POST /api/lineage/rebuild 随时重建；不是真相源';
COMMENT ON TABLE lineage_events IS
  '跨系统血缘（外部数据源接入、报告导出），rebuild 不清理';

-- ── 数据质量 ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS dq_rules (
  key         text        PRIMARY KEY,
  category    text        NOT NULL,   -- 完整性 / 唯一性 / 枚举 / 引用 / 一致性 / 新鲜度
  severity    text        NOT NULL CHECK (severity IN ('critical', 'warning')),
  description text        NOT NULL,
  -- 统一约定：返回单行单列 violations（整数），0 表示通过
  check_sql   text        NOT NULL,
  enabled     boolean     NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS dq_runs (
  id           bigserial   PRIMARY KEY,
  ran_at       timestamptz NOT NULL DEFAULT now(),
  total_rules  integer     NOT NULL,
  passed       integer     NOT NULL,
  failed       integer     NOT NULL,
  warnings     integer     NOT NULL,
  score        numeric(5,2) NOT NULL,
  status       text        NOT NULL CHECK (status IN ('healthy', 'degraded', 'critical')),
  content_hash text        NOT NULL,
  detail       jsonb       NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS dq_findings (
  id             bigserial PRIMARY KEY,
  run_id         bigint    NOT NULL REFERENCES dq_runs (id) ON DELETE CASCADE,
  rule_key       text      NOT NULL,
  severity       text      NOT NULL,
  violations     integer   NOT NULL,
  message        text      NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dq_findings_run ON dq_findings (run_id);

COMMENT ON COLUMN dq_rules.check_sql IS
  '只由服务端 seed 写入，HTTP 不开放自定义 SQL；统一返回 violations 单列';
COMMENT ON COLUMN dq_runs.score IS
  'critical 规则通过率（0-100），warning 类只提示不计分';

COMMIT;
