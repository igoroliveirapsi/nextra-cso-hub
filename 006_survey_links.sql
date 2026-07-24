-- ============================================================
-- 006_survey_links.sql
-- Nextra CSO Hub — Migration
-- ============================================================
-- A tabela survey_links é referenciada em server.js (POST/GET
-- /survey-links, GET/POST /public/survey/:token) desde a
-- construção do módulo CSAT/NPS, mas nunca foi criada em nenhuma
-- migration — causava erro 500 ao abrir a aba "Links Disparados".
--
-- 100% aditiva e idempotente — segura para rodar em produção.
-- ============================================================

CREATE TABLE IF NOT EXISTS survey_links (
  id               SERIAL PRIMARY KEY,
  token            VARCHAR(64) NOT NULL UNIQUE,
  survey_type      VARCHAR(10) NOT NULL CHECK (survey_type IN ('csat','nps')),
  client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  business_unit_id VARCHAR(10) REFERENCES business_units(id),
  ticket_id        VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  complaint_id     INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
  created_by       INTEGER REFERENCES users(id),
  responded        BOOLEAN NOT NULL DEFAULT FALSE,
  responded_at     TIMESTAMPTZ,
  score            SMALLINT,
  comment          TEXT,
  expires_at       TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '14 days'),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_survey_links_token     ON survey_links(token);
CREATE INDEX IF NOT EXISTS idx_survey_links_client    ON survey_links(client_id);
CREATE INDEX IF NOT EXISTS idx_survey_links_responded ON survey_links(responded);

-- ============================================================
-- Fim da migration 006.
-- ============================================================
