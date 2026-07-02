-- ============================================================
-- 007_users_extra_fields.sql
-- Nextra CSO Hub — Migration
-- ============================================================
-- As colunas access_level, department e phone são referenciadas
-- em server.js (GET/POST/PATCH /users) desde a construção do
-- módulo de Configurações, mas nunca foram criadas na tabela
-- users — causava erro 500 ao abrir a tela "Usuários", inclusive
-- para listar usuários já existentes (como o próprio admin).
--
-- 100% aditiva e idempotente — segura para rodar em produção.
-- ============================================================

ALTER TABLE users ADD COLUMN IF NOT EXISTS access_level VARCHAR(20) NOT NULL DEFAULT 'standard';
ALTER TABLE users ADD COLUMN IF NOT EXISTS department   VARCHAR(100);
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone        VARCHAR(30);

-- ============================================================
-- Fim da migration 007.
-- ============================================================
