-- EvalHub · 迁移 004：指标注册中心（Rubric Registry）与质量门禁
--
-- 为什么需要它：v2 里五维评分、权重、阈值全部写死在 MoonBit 引擎和 judge.js 里，
-- 别的业务线无法自定义评测标准 —— 这是「评测工具」和「评测中台」的分界线。
-- 中台的命门是「指标口径统一 + 可注册 + 可追溯」，不是功能更多。
--
-- 设计约束：
--   1. rubric 与 dataset 同规矩：一经注册不可修改，改口径只能新增 version；
--   2. content_hash 相同的内容不重复建版本（重跑幂等）；
--   3. 每个 key 只有一个 active 版本，切换 active 要留审计；
--   4. 门禁结果不落库（无状态计算），避免把可复算的派生数据变成真相源。

BEGIN;

CREATE TABLE IF NOT EXISTS rubrics (
  id            bigserial   PRIMARY KEY,
  key           text        NOT NULL,
  version       integer     NOT NULL CHECK (version > 0),
  name          text        NOT NULL,
  description   text,
  -- [{key,label,weight,min_score,max_score}]，权重和必须为 1
  dimensions    jsonb       NOT NULL,
  -- {min_total, min_dims:{dim:number}, max_fail_rate}
  gate          jsonb       NOT NULL,
  content_hash  text        NOT NULL,
  is_active     boolean     NOT NULL DEFAULT false,
  created_by    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (key, version),
  UNIQUE (key, content_hash)
);

CREATE INDEX IF NOT EXISTS idx_rubrics_key_active ON rubrics (key, is_active);

-- 每个 key 最多一个 active 版本（部分唯一索引，比触发器轻）
CREATE UNIQUE INDEX IF NOT EXISTS uq_rubrics_one_active
  ON rubrics (key) WHERE is_active = true;

COMMENT ON COLUMN rubrics.content_hash IS
  'dimensions + gate 规范化后的 SHA-256；同内容不重复建版本，保证口径幂等';
COMMENT ON COLUMN rubrics.is_active IS
  '每个 key 只有一个生效版本；切换时先把旧版本置 false，再置新版本 true';

COMMIT;
