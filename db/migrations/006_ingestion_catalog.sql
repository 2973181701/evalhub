-- EvalHub · 迁移 006：口径血缘补全 + 数据接入 + 资产目录
--
-- 对应上一轮数据中台落地后暴露的两个缺口之一：
--   eval_runs 未记录 rubric 版本 → 无法回答「这次评测用的是哪个口径」。
-- 另补上数据中台剩下的两块最小能力：可追溯的数据接入、统一的资产目录。
--
-- 设计约束：
--   1. 历史 run 的 rubric_key / version 保持 NULL，**不伪造回填**；
--      血缘重建时只为有口径记录的 run 建 scored_by 边。
--   2. 接入批次记录原始 payload 与拒绝原因，可复算、可审计；
--      同 content_hash 不重复建数据集版本（与 datasets 的不可变约定一致）。
--   3. 资产目录是**视图**（派生），不是第二份真相源。

BEGIN;

-- ── 1. 口径血缘 ──────────────────────────────────────────────────────
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS rubric_key      text;
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS rubric_version  integer;

CREATE INDEX IF NOT EXISTS idx_eval_runs_rubric ON eval_runs (rubric_key, rubric_version);

COMMENT ON COLUMN eval_runs.rubric_key IS
  '创建任务时生效的口径 key；历史 run 为 NULL，不回填伪造';
COMMENT ON COLUMN eval_runs.rubric_version IS
  '创建任务时生效的口径版本；与 rubric_key 一起构成口径血缘';

-- ── 2. 数据接入批次 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ingestion_batches (
  id               bigserial   PRIMARY KEY,
  name             text        NOT NULL UNIQUE,
  source_type      text        NOT NULL CHECK (source_type IN ('json','csv','manual','api')),
  source_uri       text        NOT NULL,
  content_hash     text        NOT NULL,
  row_count        integer     NOT NULL DEFAULT 0,
  accepted_count   integer     NOT NULL DEFAULT 0,
  rejected_count   integer     NOT NULL DEFAULT 0,
  status           text        NOT NULL CHECK (status IN ('dry_run','committed','failed')),
  target_dataset   text,
  target_version   integer,
  report           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  note             text,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ingestion_rejects (
  id          bigserial   PRIMARY KEY,
  batch_id    bigint      NOT NULL REFERENCES ingestion_batches (id) ON DELETE CASCADE,
  row_index   integer     NOT NULL,
  reason      text        NOT NULL,
  payload     jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_ingestion_hash ON ingestion_batches (content_hash);

COMMENT ON TABLE ingestion_batches IS
  '一次外部数据接入的可审计记录；同内容哈希不重复建数据集版本';

-- ── 3. 资产目录（派生视图） ──────────────────────────────────────────
CREATE OR REPLACE VIEW v_asset_catalog AS
SELECT 'dataset'::text     AS asset_type,
       d.name || '@v' || d.version::text AS asset_key,
       left(d.content_hash, 16) AS content_hash,
       d.item_count::integer AS item_count,
       'active'::text      AS status,
       d.note              AS description,
       d.created_at
  FROM datasets d
UNION ALL
SELECT 'rubric', r.key || '@v' || r.version::text,
       left(r.content_hash, 16),
       jsonb_array_length(r.dimensions),
       CASE WHEN r.is_active THEN 'active' ELSE 'archived' END,
       r.description, r.created_at
  FROM rubrics r
UNION ALL
SELECT 'label_batch', b.name, left(b.content_hash, 16),
       b.pair_count, 'active', b.note, b.created_at
  FROM label_batches b
UNION ALL
SELECT 'eval_run', r.id::text, left(coalesce(r.config_hash,''), 16),
       r.total_items, r.status,
       r.provider || ' / ' || coalesce(r.rubric_key, 'no-rubric'),
       r.created_at
  FROM eval_runs r
UNION ALL
SELECT 'ingestion', b.name, left(b.content_hash, 16),
       b.accepted_count, b.status,
       b.source_type || ':' || b.source_uri, b.created_at
  FROM ingestion_batches b;

COMMENT ON VIEW v_asset_catalog IS
  '把数据集/口径/标注批次/评测任务/接入批次统一成可检索资产；派生视图，不存第二份真相源';

COMMIT;
