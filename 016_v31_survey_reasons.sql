-- ═══════════════════════════════════════════════════════════════
-- 016_v31_survey_reasons.sql — Nextra CSO Hub v3.1
-- Pesquisas CSAT/NPS com motivos estruturados (chips de um toque).
-- A nota diz QUE dói; o motivo diz ONDE dói — e vira alavanca
-- operacional no relatório "Motivos por nota".
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE csat ADD COLUMN IF NOT EXISTS reasons TEXT[];
ALTER TABLE nps  ADD COLUMN IF NOT EXISTS reasons TEXT[];
CREATE INDEX IF NOT EXISTS idx_csat_reasons ON csat USING GIN (reasons);
CREATE INDEX IF NOT EXISTS idx_nps_reasons  ON nps  USING GIN (reasons);

-- v3.1: contato do chamado — a pesquisa vai para quem viveu o atendimento,
-- não para o e-mail genérico da empresa. Fallback: e-mail do cadastro do cliente.
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS contact_name  VARCHAR(255);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS contact_email VARCHAR(255);
