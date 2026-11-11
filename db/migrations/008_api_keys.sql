-- ============================================================================
-- 008 · 服务化 API Key（机器对机器）
--
-- 为什么要它：JWT 是给「人」用的，几小时就过期，也不可能塞进 CI 的 secret；
-- 而「评测中台」的核心价值就在于**别的系统能调它**（CI 流水线、训练平台、
-- 发布系统）。没有长期凭据，服务化就是一句空话。
--
-- 设计要点：
--   - 明文只在创建时返回一次，库里只存 SHA-256。库被拖走也不能直接当密钥用。
--   - 密钥绑定**租户 + 角色**：一把 key 只能在一个业务线内动作，不会因为
--     图省事就变成「全平台万能钥匙」。
--   - 只支持撤销，不支持「查看」。撤销留时间戳，便于事后追责。
--   - last_used_at 用于识别僵尸密钥（长期不用就该撤）。
--
-- 可重复执行。
-- ============================================================================

BEGIN;

CREATE TABLE IF NOT EXISTS api_keys (
  id           bigserial   PRIMARY KEY,
  tenant_id    bigint      NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
  name         text        NOT NULL,
  key_prefix   text        NOT NULL,          -- 明文前缀（如 ehk_ab12cd34），用于人对人识别
  key_hash     text        NOT NULL UNIQUE,   -- sha256(完整明文)，永不返回
  role         text        NOT NULL CHECK (role IN ('viewer', 'evaluator', 'admin')),
  description  text,
  created_by   bigint      REFERENCES users (id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz,
  UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant ON api_keys (tenant_id, revoked_at);

COMMENT ON COLUMN api_keys.key_hash IS 'sha256(完整明文)，明文只在创建时返回一次，之后无法取回';
COMMENT ON COLUMN api_keys.role IS '该密钥在所属业务线内的角色，不能跨业务线使用';

COMMIT;
