-- EvalHub 迁移 002：eval_runs 记录本次任务实际选中的题目
--
-- 背景：POST /api/runs 支持传 ids 只跑部分题目，但选题结果没有落库，
-- worker 只能按「数据集全量」执行 —— 结果是 total_items=3、实际跑 20 条、
-- 进度显示 20/3，且结果里混入了没人要的题目。
--
-- 可重复执行（IF NOT EXISTS）。

BEGIN;

ALTER TABLE eval_runs
  ADD COLUMN IF NOT EXISTS item_keys text[];

COMMENT ON COLUMN eval_runs.item_keys IS '本次任务选中的题目标识；NULL 表示数据集全量';

-- 历史任务回填为 NULL（视为全量），语义与当时行为一致，不做猜测性修改

COMMIT;
