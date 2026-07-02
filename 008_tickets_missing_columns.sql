-- ============================================================
-- 008_tickets_missing_columns.sql
-- Nextra CSO Hub — Migration
-- ============================================================
-- ACHADO CRÍTICO: a coluna previous_action é usada no INSERT de
-- criação de chamado (POST /tickets) desde sempre, mas nunca foi
-- criada na tabela tickets. Isso quebrava a criação de QUALQUER
-- chamado novo pela tela — mascarado até agora porque todos os
-- chamados testados vieram do seed inicial do banco (seed.js),
-- nunca de um cadastro real via "+ Novo Chamado".
--
-- resolved_at também é usado no PATCH de status (ao marcar um
-- chamado como "resolvido"), mas só existia na tabela complaints,
-- não em tickets — quebraria o encerramento como resolvido.
--
-- 100% aditiva e idempotente — segura para rodar em produção.
-- ============================================================

ALTER TABLE tickets ADD COLUMN IF NOT EXISTS previous_action TEXT;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS resolved_at     TIMESTAMPTZ;

-- ============================================================
-- Fim da migration 008.
-- ============================================================
