-- ============================================================
-- 005_v1_1_enhancements.sql
-- Nextra CSO Hub — Migration reconstituída
-- ============================================================
-- Esta migration estava referenciada em migrate.js mas ausente do
-- repositório Git. Foi reconstruída a partir das colunas que o
-- server.js já espera encontrar em produção (confirmado via erros
-- 500 reais em /api/v1/returns e diagnóstico de POST /api/v1/rma).
--
-- 100% aditiva: nenhuma tabela é apagada, nenhum dado é alterado.
-- Todas as instruções são idempotentes (IF NOT EXISTS) e seguras
-- para rodar em produção com dados existentes.
-- ============================================================

-- ── 1. Enum user_role — adiciona 'financial' ──────────────────
-- RMA e Estoque (warehouse) já existiam. Faltava só Financeiro.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'financial';

-- ── 2. Tabela returns — análise de custo + NF + causa raiz ────
ALTER TABLE returns ADD COLUMN IF NOT EXISTS nf_value NUMERIC(15,2);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS nf_attached BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS root_cause VARCHAR(50);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS root_cause_notes TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reduction_action TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reduction_feasible BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS tax_cost NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS freight_cost NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS refaturamento_cost NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS difal_cost NUMERIC(15,2) NOT NULL DEFAULT 0;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS cost_status VARCHAR(50);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS reject_reason TEXT;

-- Overhead de galpão: 1,5% sobre o valor da NF anexada, calculado
-- automaticamente pelo banco — nunca digitado manualmente.
ALTER TABLE returns ADD COLUMN IF NOT EXISTS warehouse_overhead_cost NUMERIC(15,2)
  GENERATED ALWAYS AS (ROUND(COALESCE(nf_value, 0) * 0.015, 2)) STORED;

-- ── 3. Tabela rma — custo unitário + desfecho + rebate ────────
ALTER TABLE rma ADD COLUMN IF NOT EXISTS unit_cost NUMERIC(15,2);
ALTER TABLE rma ADD COLUMN IF NOT EXISTS outcome_type VARCHAR(50);
ALTER TABLE rma ADD COLUMN IF NOT EXISTS rebate_applicable BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE rma ADD COLUMN IF NOT EXISTS rebate_value NUMERIC(15,2);
ALTER TABLE rma ADD COLUMN IF NOT EXISTS rebate_status VARCHAR(50);
ALTER TABLE rma ADD COLUMN IF NOT EXISTS supplier_id INTEGER REFERENCES suppliers(id) ON DELETE SET NULL;

-- ── 4. Índices de apoio (idempotentes) ────────────────────────
CREATE INDEX IF NOT EXISTS idx_returns_root_cause ON returns(root_cause) WHERE root_cause IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rma_outcome_type   ON rma(outcome_type) WHERE outcome_type IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rma_supplier       ON rma(supplier_id);

-- ============================================================
-- Fim da migration 005. Commitar este arquivo é o que faltava
-- para o deploy a partir do zero (Railway) não quebrar mais em
-- "Arquivo não encontrado: 005_v1_1_enhancements.sql".
-- ============================================================
