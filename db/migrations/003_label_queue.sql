-- EvalHub · 迁移 003：标注队列（数据飞轮 / 留出集）
-- 目标：把「评测产生的真实回答」变成可标注的 A/B 对，让 Judge 的 κ 有一个
--       不被提示词设计过程污染的留出集。
--
-- 三条硬约束（对应评测工程的基本要求）：
--   1. 盲标：expected_choice（生成时的设计意图）与 split（train/test）存在库里，
--      但**绝不能出现在标注接口响应中**，否则标注者会被锚定。
--   2. 标签来源可追溯：只有 label_source='human' 的记录能进金标准。
--      自动化测试写入的标注必须是 'test_fixture'，评估脚本一律过滤掉。
--   3. 切分确定性：split 由题目内容哈希决定，同一题的所有变体必须落在同一侧，
--      否则同一道题的训练变体会泄漏进测试集。
--
-- 可重复执行（IF NOT EXISTS / CREATE OR REPLACE VIEW）。

BEGIN;

CREATE TABLE IF NOT EXISTS label_batches (
  id            bigserial PRIMARY KEY,
  name          text        NOT NULL UNIQUE,
  generator     text        NOT NULL,          -- 生成脚本 + 版本，便于复现
  config        jsonb       NOT NULL DEFAULT '{}'::jsonb,
  content_hash  text        NOT NULL,
  pair_count    integer     NOT NULL DEFAULT 0 CHECK (pair_count >= 0),
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS label_pairs (
  id                text        PRIMARY KEY,
  batch_id          bigint      NOT NULL REFERENCES label_batches (id) ON DELETE CASCADE,
  source_prompt_id  text        NOT NULL,       -- 原始题号，用于按题切分
  task_type         text        NOT NULL,
  prompt            text        NOT NULL,
  reference         text,
  answer_a          text        NOT NULL,
  answer_b          text        NOT NULL,
  strategy_a        text        NOT NULL,
  strategy_b        text        NOT NULL,
  -- 生成时的「设计意图」，仅用于事后分析数据难度，绝不作为标签使用
  expected_choice   text        CHECK (expected_choice IN ('A', 'B', '平手') OR expected_choice IS NULL),
  -- 留出集分组：按 source_prompt_id 哈希确定，同题所有 pair 必须同侧
  split             text        NOT NULL CHECK (split IN ('train', 'test')),
  origin            text        NOT NULL DEFAULT 'generated'
                    CHECK (origin IN ('generated', 'eval_run', 'seed')),
  run_id            uuid,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_label_pairs_batch ON label_pairs (batch_id);
CREATE INDEX IF NOT EXISTS idx_label_pairs_split ON label_pairs (split);
CREATE INDEX IF NOT EXISTS idx_label_pairs_task  ON label_pairs (task_type);

CREATE TABLE IF NOT EXISTS label_annotations (
  id             bigserial   PRIMARY KEY,
  pair_id        text        NOT NULL REFERENCES label_pairs (id) ON DELETE CASCADE,
  -- 非空，保证唯一约束对匿名标注者也生效（NULL 在 PG 唯一约束里互不相等）
  annotator_key  text        NOT NULL DEFAULT 'anonymous',
  choice         text        NOT NULL CHECK (choice IN ('A', 'B', '平手')),
  reason         text,
  confidence     integer     CHECK (confidence IS NULL OR (confidence BETWEEN 1 AND 5)),
  -- 唯一可信的金标准来源；test_fixture / synthetic 一律被评估脚本排除
  label_source   text        NOT NULL DEFAULT 'human'
                 CHECK (label_source IN ('human', 'test_fixture')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (pair_id, annotator_key)
);

CREATE INDEX IF NOT EXISTS idx_label_ann_source ON label_annotations (label_source);
CREATE INDEX IF NOT EXISTS idx_label_ann_pair   ON label_annotations (pair_id);

-- 待标注队列：只暴露盲标所需字段。
-- ⚠️ 不含 expected_choice / split / strategy_a / strategy_b / reference：
--    策略名（如 concise|verbose）会直接暴露生成时的设计意图，把标注者锚定到预期答案。
-- ⚠️ CREATE OR REPLACE VIEW 在 PG 里不能删列，改列结构必须 DROP 后重建
DROP VIEW IF EXISTS v_label_queue;
CREATE VIEW v_label_queue AS
SELECT p.id,
       p.task_type,
       p.prompt,
       p.answer_a,
       p.answer_b,
       p.batch_id,
       p.created_at,
       EXISTS (SELECT 1 FROM label_annotations a WHERE a.pair_id = p.id) AS labeled
  FROM label_pairs p;

COMMENT ON COLUMN label_pairs.expected_choice IS
  '生成时的设计意图，仅用于分析数据难度与标签偏差；禁止作为金标准，禁止返回给标注界面';
COMMENT ON COLUMN label_pairs.split IS
  '按 source_prompt_id 确定性哈希切分，同题的所有变体必须落在同一侧，防止题目泄漏';
COMMENT ON COLUMN label_annotations.label_source IS
  '只有 human 可进入 κ 计算；test_fixture 是流程自检写入的模拟标注，必须排除';

COMMIT;
