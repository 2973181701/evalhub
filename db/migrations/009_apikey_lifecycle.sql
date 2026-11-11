-- ============================================================================
-- 009 · API Key 生命周期与限流
--
-- 三个企业里一定会被问到的问题，这一版补上：
--   1. 密钥怎么轮换？      → expires_at + 轮换宽限期（新旧并行一段时间，再自动失效）
--   2. 一把 key 刷爆额度怎么办？ → 按 key 的每分钟配额（多实例安全，走库计数）
--   3. 这把 key 到底用了多少？  → api_key_usage 计数，列表里回报最近 24 小时请求数
--
-- 为什么限流计数放数据库而不是进程内存：
--   平台可能多副本部署，内存计数各算各的，等于额度乘以副本数。
--   固定窗口 + UPSERT 自增足够便宜，也不引入 Redis 这种额外依赖。
--
-- 可重复执行。
-- ============================================================================

BEGIN;

ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS expires_at          timestamptz;
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rotated_from        bigint REFERENCES api_keys (id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS rate_limit_per_min integer NOT NULL DEFAULT 60;

-- 配额下限要卡住：0 或负数会让密钥创建后立刻不可用，属于配置错误而非限制
ALTER TABLE api_keys DROP CONSTRAINT IF EXISTS api_keys_rate_limit_check;
ALTER TABLE api_keys ADD CONSTRAINT api_keys_rate_limit_check
  CHECK (rate_limit_per_min BETWEEN 1 AND 100000);

CREATE TABLE IF NOT EXISTS api_key_usage (
  key_id       bigint      NOT NULL REFERENCES api_keys (id) ON DELETE CASCADE,
  window_start timestamptz NOT NULL,          -- 按分钟对齐（date_trunc('minute')）
  count        integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

CREATE INDEX IF NOT EXISTS idx_api_key_usage_window ON api_key_usage (window_start);

COMMENT ON COLUMN api_keys.expires_at IS '到期后密钥自动失效；轮换时给旧密钥设一个宽限期，避免调用方瞬间断流';
COMMENT ON COLUMN api_keys.rotated_from IS '由哪把密钥轮换而来，便于追一条密钥的传承链';
COMMENT ON COLUMN api_keys.rate_limit_per_min IS '每分钟请求上限，默认 60；按 key 计，多实例共享同一份计数';

COMMIT;
