-- EvalHub · PostgreSQL schema v1
-- 目标：把 data/*.json 的只读快照升级为可版本化、可审计、可并发写入的数据层。
-- 设计约束：
--   1. 数据集不可变（immutable）：一次导入 = 一个 version，写入后不再 UPDATE，只允许新增 version。
--   2. 评测结果必须可复现：run 记录 config + config_hash，同一 dataset version + 同一 config_hash 重跑应得到同一结果集。
--   3. 标注可追溯：保留 annotator / source / 时间，种子数据与运行期提交同表区分。
-- 适用：PostgreSQL 13+（使用内置 gen_random_uuid()，不需要 pgcrypto 扩展）

BEGIN;

-- ============================================================
-- 1. 数据集与条目
-- ============================================================

CREATE TABLE IF NOT EXISTS datasets (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL,
  version       integer     NOT NULL CHECK (version > 0),
  content_hash  text        NOT NULL,
  task_types    text[]      NOT NULL DEFAULT '{}',
  item_count    integer     NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  note          text,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (name, version),
  UNIQUE (name, content_hash)          -- 同一内容不重复建版本
);

COMMENT ON COLUMN datasets.content_hash IS '条目内容规范化后的 SHA-256，用于判定「内容是否变化」而非「是否重跑」';

CREATE TABLE IF NOT EXISTS dataset_items (
  id         bigserial PRIMARY KEY,
  dataset_id bigint NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  item_key   text   NOT NULL,           -- 原始 JSON 的 id，如 K01 / P01
  task_type  text   NOT NULL,
  prompt     text   NOT NULL,
  reference  text,
  UNIQUE (dataset_id, item_key)
);

CREATE TABLE IF NOT EXISTS dataset_pairs (
  id               bigserial PRIMARY KEY,
  dataset_id       bigint NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  item_key         text   NOT NULL,
  task_type        text   NOT NULL,
  prompt           text   NOT NULL,
  reference        text,
  answer_a         text   NOT NULL,
  answer_b         text   NOT NULL,
  strategy_a       text,
  strategy_b       text,
  strategy_a_label text,
  strategy_b_label text,
  UNIQUE (dataset_id, item_key)
);

CREATE TABLE IF NOT EXISTS dataset_answers (
  id         bigserial PRIMARY KEY,
  dataset_id bigint NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  item_key   text   NOT NULL,
  task_type  text   NOT NULL,
  prompt     text   NOT NULL,
  answer     text   NOT NULL,
  model      text,
  UNIQUE (dataset_id, item_key)
);

-- ============================================================
-- 2. 用户与审计
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id            bigserial PRIMARY KEY,
  email         text        NOT NULL UNIQUE,
  password_hash text        NOT NULL,
  display_name  text,
  role          text        NOT NULL DEFAULT 'viewer'
                            CHECK (role IN ('admin', 'evaluator', 'viewer')),
  is_active     boolean     NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id         bigserial PRIMARY KEY,
  actor_id   bigint REFERENCES users (id) ON DELETE SET NULL,
  action     text        NOT NULL,      -- dataset.import / annotation.submit / run.create / user.role_change
  target     text,
  detail     jsonb       NOT NULL DEFAULT '{}'::jsonb,
  ip         inet,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_time ON audit_logs (actor_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action     ON audit_logs (action, created_at DESC);

-- ============================================================
-- 3. 标注
-- ============================================================

CREATE TABLE IF NOT EXISTS annotations (
  id           bigserial PRIMARY KEY,
  dataset_id   bigint      NOT NULL REFERENCES datasets (id) ON DELETE CASCADE,
  item_key     text        NOT NULL,
  annotator_id bigint      REFERENCES users (id) ON DELETE SET NULL,
  -- 取值域与 MoonBit 引擎严格对齐（core/src/engine_analyze.mbt choice_cats），
  -- 不在 DB 层做 A/B/平手 → 英文的翻译，避免两套语义漂移
  choice       text        NOT NULL CHECK (choice IN ('A', 'B', '平手')),
  reason       text,
  confidence   smallint    CHECK (confidence BETWEEN 1 AND 5),
  source       text        NOT NULL DEFAULT 'submitted'
                           CHECK (source IN ('seed', 'submitted')),
  submitted_at timestamptz NOT NULL DEFAULT now(),
  -- 同一数据集同一题，同一标注者只保留一条；重提走 upsert
  UNIQUE (dataset_id, item_key, annotator_id)
);

CREATE INDEX IF NOT EXISTS idx_annotations_dataset ON annotations (dataset_id, source);

COMMENT ON COLUMN annotations.source IS 'seed = 仓库内已冻结的人工标注快照；submitted = 运行期通过 API 提交';

-- ============================================================
-- 4. 评测运行与结果
-- ============================================================

CREATE TABLE IF NOT EXISTS eval_runs (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  dataset_id   bigint      NOT NULL REFERENCES datasets (id) ON DELETE RESTRICT,
  provider     text        NOT NULL,          -- glm / openai / vllm
  model        text        NOT NULL,
  config       jsonb       NOT NULL DEFAULT '{}'::jsonb,
  config_hash  text        NOT NULL,          -- config 规范化后的哈希，用于结果复现校验
  status       text        NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
  total_items  integer     NOT NULL DEFAULT 0,
  item_keys    text[],                       -- 本次选中的题目；NULL = 数据集全量
  done_items   integer     NOT NULL DEFAULT 0,
  failed_items integer     NOT NULL DEFAULT 0,
  tokens_in    bigint      NOT NULL DEFAULT 0,
  tokens_out   bigint      NOT NULL DEFAULT 0,
  cost_usd     numeric(12, 6) NOT NULL DEFAULT 0,
  error        text,
  created_by   bigint      REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  started_at   timestamptz,
  finished_at  timestamptz
);

CREATE INDEX IF NOT EXISTS idx_eval_runs_dataset ON eval_runs (dataset_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_eval_runs_status  ON eval_runs (status) WHERE status IN ('queued', 'running');

CREATE TABLE IF NOT EXISTS eval_results (
  id         bigserial PRIMARY KEY,
  run_id     uuid   NOT NULL REFERENCES eval_runs (id) ON DELETE CASCADE,
  item_key   text   NOT NULL,
  scores     jsonb  NOT NULL DEFAULT '{}'::jsonb,   -- {"accuracy":2.67,"fluency":4,...}
  total      numeric(6, 3),
  output     text,
  latency_ms integer,
  tokens_in  integer,
  tokens_out integer,
  cost_usd   numeric(12, 6),
  error      text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (run_id, item_key)
);

CREATE INDEX IF NOT EXISTS idx_eval_results_run ON eval_results (run_id);

-- ============================================================
-- 5. 幂等闸门：同一 (dataset, config_hash, model) 的已完成 run
--    用于「同配置重跑」检测与结果比对，不阻止重跑，只提供查询依据
-- ============================================================

CREATE OR REPLACE VIEW v_run_reproducibility AS
SELECT r.id,
       r.dataset_id,
       r.provider,
       r.model,
       r.config_hash,
       r.status,
       r.done_items,
       r.created_at,
       count(x.id) AS result_rows
FROM eval_runs r
         LEFT JOIN eval_results x ON x.run_id = r.id
GROUP BY r.id;

COMMIT;
