-- ============================================================================
-- 007 · 多租户隔离（业务线 / 项目空间）
--
-- 模型：**全局基线 + 租户工作区**
--   datasets.tenant_id IS NULL  → 平台共享的只读基线数据集（如 evalhub-core）
--   tenant_id 非空              → 该业务线自己的资产（接入的数据集、口径、任务、队列）
--
-- 为什么基线不复制到每个租户：
--   复制会让「同一份 20 题基线」在不同业务线出现多个版本号，跨租户比较时
--   无法判断差异来自模型还是数据，正好破坏了这个平台最核心的「可复现」前提。
--
-- 可重复执行。所有 ALTER 都带 IF NOT EXISTS；约束重建前先 DROP IF EXISTS。
-- ============================================================================

BEGIN;

-- ── 1. 租户表 ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tenants (
  id          bigserial   PRIMARY KEY,
  slug        text        NOT NULL UNIQUE,          -- 稳定标识，用于 URL / 配置
  name        text        NOT NULL,
  description text,
  status      text        NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'suspended')),
  settings    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- 迁移前的存量资产统一归到 platform，避免出现「无归属」数据
INSERT INTO tenants (slug, name, description)
VALUES ('platform', '平台默认空间', '迁移前的存量资产归属；新业务线从此继承默认口径')
ON CONFLICT (slug) DO NOTHING;

-- ── 2. 成员与「每租户角色」 ───────────────────────────────────────────────
-- users.role 保留为平台级角色（用于 /api/users 等平台管理），
-- 具体到某个业务线的权限由 user_tenants.role 决定 —— 同一个人可以在
-- A 业务线是 admin、在 B 业务线只是 viewer，这是多租户 RBAC 的实质。
CREATE TABLE IF NOT EXISTS user_tenants (
  user_id    bigint      NOT NULL REFERENCES users (id)   ON DELETE CASCADE,
  tenant_id  bigint      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  role       text        NOT NULL CHECK (role IN ('viewer', 'evaluator', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tenant_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tenants_tenant ON user_tenants (tenant_id);

-- 存量用户回填为「默认空间」成员，角色沿用其平台级角色。
-- 不做「没有成员记录就放行默认空间」的兜底 —— 那种兜底会让新建用户默认获得权限，
-- 是典型的多租户越权入口。
INSERT INTO user_tenants (user_id, tenant_id, role)
SELECT u.id, t.id, u.role
  FROM users u
  CROSS JOIN tenants t
 WHERE t.slug = 'platform'
ON CONFLICT (user_id, tenant_id) DO NOTHING;

-- ── 3. datasets：基线全局，其余归默认空间 ────────────────────────────────
ALTER TABLE datasets ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);

UPDATE datasets
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'platform')
 WHERE tenant_id IS NULL
   AND name <> 'evalhub-core';   -- 只把演示接入的 ingested 收归默认空间，基线保持全局

ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_name_version_key;
ALTER TABLE datasets DROP CONSTRAINT IF EXISTS datasets_name_content_hash_key;

CREATE UNIQUE INDEX IF NOT EXISTS uq_datasets_global_name_version
  ON datasets (name, version) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_datasets_global_name_hash
  ON datasets (name, content_hash) WHERE tenant_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_datasets_tenant_name_version
  ON datasets (tenant_id, name, version) WHERE tenant_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_datasets_tenant_name_hash
  ON datasets (tenant_id, name, content_hash) WHERE tenant_id IS NOT NULL;

-- ── 4. rubrics：口径必须归属某个业务线 ──────────────────────────────────
ALTER TABLE rubrics ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);
UPDATE rubrics
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'platform')
 WHERE tenant_id IS NULL;
ALTER TABLE rubrics ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE rubrics DROP CONSTRAINT IF EXISTS rubrics_key_version_key;
ALTER TABLE rubrics DROP CONSTRAINT IF EXISTS rubrics_key_content_hash_key;
DROP INDEX IF EXISTS uq_rubrics_one_active;

CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_tenant_key_version ON rubrics (tenant_id, key, version);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_tenant_key_hash    ON rubrics (tenant_id, key, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_tenant_one_active  ON rubrics (tenant_id, key) WHERE is_active;
CREATE INDEX IF NOT EXISTS idx_rubrics_tenant_active ON rubrics (tenant_id, key, is_active);

-- ── 5. eval_runs ────────────────────────────────────────────────────────
ALTER TABLE eval_runs ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);
UPDATE eval_runs
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'platform')
 WHERE tenant_id IS NULL;
ALTER TABLE eval_runs ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_eval_runs_tenant_created ON eval_runs (tenant_id, created_at DESC);

-- ── 6. 标注队列 ─────────────────────────────────────────────────────────
ALTER TABLE label_batches ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);
UPDATE label_batches
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'platform')
 WHERE tenant_id IS NULL;
ALTER TABLE label_batches ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE label_batches DROP CONSTRAINT IF EXISTS label_batches_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_label_batches_tenant_name ON label_batches (tenant_id, name);

ALTER TABLE label_pairs ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);
UPDATE label_pairs p
   SET tenant_id = b.tenant_id
  FROM label_batches b
 WHERE p.batch_id = b.id AND p.tenant_id IS NULL;
ALTER TABLE label_pairs ALTER COLUMN tenant_id SET NOT NULL;
CREATE INDEX IF NOT EXISTS idx_label_pairs_tenant_split ON label_pairs (tenant_id, split);

-- ── 7. 接入批次 ─────────────────────────────────────────────────────────
ALTER TABLE ingestion_batches ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);
UPDATE ingestion_batches
   SET tenant_id = (SELECT id FROM tenants WHERE slug = 'platform')
 WHERE tenant_id IS NULL;
ALTER TABLE ingestion_batches ALTER COLUMN tenant_id SET NOT NULL;

ALTER TABLE ingestion_batches DROP CONSTRAINT IF EXISTS ingestion_batches_name_key;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ingestion_batches_tenant_name
  ON ingestion_batches (tenant_id, name);

-- ── 8. 审计日志：带租户标签，便于按业务线追责 ────────────────────────────
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS tenant_id bigint REFERENCES tenants (id);

-- ── 9. 视图重建（加 tenant_id；PG 的 CREATE OR REPLACE VIEW 不能加列前的删列） ──
DROP VIEW IF EXISTS v_label_queue;
CREATE VIEW v_label_queue AS
SELECT p.id,
       p.tenant_id,
       p.task_type,
       p.prompt,
       p.answer_a,
       p.answer_b,
       p.batch_id,
       p.created_at,
       EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id = p.id) AS labeled
  FROM label_pairs p;

DROP VIEW IF EXISTS v_asset_catalog;
CREATE VIEW v_asset_catalog AS
SELECT 'dataset'::text     AS asset_type,
       d.tenant_id,
       d.name || '@v' || d.version::text AS asset_key,
       left(d.content_hash, 16) AS content_hash,
       d.item_count::integer AS item_count,
       'active'::text      AS status,
       d.note              AS description,
       d.created_at
  FROM datasets d
UNION ALL
SELECT 'rubric', r.tenant_id, r.key || '@v' || r.version::text,
       left(r.content_hash, 16),
       jsonb_array_length(r.dimensions),
       CASE WHEN r.is_active THEN 'active' ELSE 'archived' END,
       r.description, r.created_at
  FROM rubrics r
UNION ALL
SELECT 'label_batch', b.tenant_id, b.name, left(b.content_hash, 16),
       b.pair_count, 'active', b.note, b.created_at
  FROM label_batches b
UNION ALL
SELECT 'eval_run', r.tenant_id, r.id::text, left(coalesce(r.config_hash, ''), 16),
       r.total_items, r.status,
       r.provider || ' / ' || coalesce(r.rubric_key, 'no-rubric'),
       r.created_at
  FROM eval_runs r
UNION ALL
SELECT 'ingestion', b.tenant_id, b.name, left(b.content_hash, 16),
       b.accepted_count, b.status,
       b.source_type || ':' || b.source_uri, b.created_at
  FROM ingestion_batches b;

COMMIT;

COMMENT ON COLUMN tenants.slug IS '稳定标识，登录 / 切租户时使用；一旦启用不要改';
COMMENT ON COLUMN user_tenants.role IS '该用户在该业务线的角色，覆盖 users.role；用于多租户 RBAC';
COMMENT ON COLUMN datasets.tenant_id IS 'NULL = 平台共享只读基线；非空 = 业务线私有数据集';
