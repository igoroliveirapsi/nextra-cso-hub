-- ═══════════════════════════════════════════════════════════════
-- 013_app_settings.sql — Nextra CSO Hub v2.2
-- Tabela chave-valor para configurações persistentes da aplicação
-- (usada pela conexão OAuth do Google Drive, entre outros).
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS app_settings (
  key        VARCHAR(100) PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
