-- ============================================================
-- 010_operational_flow_enhancements.sql
-- Nextra CSO Hub — Migration
-- ============================================================
-- 100% ADITIVA e IDEMPOTENTE. Nenhuma migration anterior é
-- alterada. Nenhum dado é apagado. Todas as instruções usam
-- IF NOT EXISTS / DO $$ ... $$ guards para poder rodar em
-- produção com segurança, mesmo que parte já tenha sido aplicada.
--
-- Cobre:
--  1) Chamados: quantidade, grupo do produto, marca
--  2) NF obrigatória em Chamados (com identificação de legado
--     para registros existentes sem NF, sem apagar nada)
--  3) Inspeção de Devolução (Devolução → Inspeção → RMA)
--  4) Vínculo return_id no RMA + prevenção de RMA ativo duplicado
--     para a mesma Devolução
--  5) Índices de apoio
-- ============================================================

-- ── 1. Chamados: quantidade, grupo do produto, marca ──────────
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS quantity INTEGER;
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS product_group VARCHAR(150);
ALTER TABLE tickets ADD COLUMN IF NOT EXISTS brand VARCHAR(150);

-- Backfill de quantidade para chamados existentes sem valor —
-- assume 1 (o mínimo válido) em vez de deixar NULL, para permitir
-- a constraint de "maior que zero" abaixo sem quebrar dados antigos.
UPDATE tickets SET quantity = 1 WHERE quantity IS NULL;

ALTER TABLE tickets ALTER COLUMN quantity SET DEFAULT 1;
ALTER TABLE tickets ALTER COLUMN quantity SET NOT NULL;

DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_quantity_positive CHECK (quantity > 0);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── 2. NF obrigatória em Chamados ──────────────────────────────
-- Registros existentes sem NF (ou com espaços em branco) recebem
-- uma identificação técnica de legado — NUNCA são apagados.
UPDATE tickets
   SET nf_number = 'LEGADO-SEM-NF-' || id
 WHERE nf_number IS NULL OR btrim(nf_number) = '';

-- Constraint: a partir de agora, todo INSERT/UPDATE exige NF
-- preenchida (a aplicação também valida isso antes de enviar).
DO $$ BEGIN
  ALTER TABLE tickets ADD CONSTRAINT tickets_nf_not_blank CHECK (btrim(nf_number) <> '');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE tickets ALTER COLUMN nf_number SET NOT NULL;

-- ── 3. Inspeção de Devolução (Devolução → Inspeção → RMA) ──────
DO $$ BEGIN
  CREATE TYPE inspection_result AS ENUM (
    'awaiting_test','approved_functional','rejected_defect','inconclusive'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_status inspection_result NOT NULL DEFAULT 'awaiting_test';
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_date DATE;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_technician_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_third_party_company VARCHAR(255);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_physical_condition VARCHAR(100);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_functional_result VARCHAR(100);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS inspection_report TEXT;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS available_for_resale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS linked_rma_id INTEGER; -- FK adicionada após a coluna rma existir (abaixo)

-- ── 4. Vínculo return_id no RMA + prevenção de RMA ativo duplicado ──
ALTER TABLE rma ADD COLUMN IF NOT EXISTS return_id INTEGER REFERENCES returns(id) ON DELETE SET NULL;

DO $$ BEGIN
  ALTER TABLE returns ADD CONSTRAINT returns_linked_rma_id_fkey FOREIGN KEY (linked_rma_id) REFERENCES rma(id) ON DELETE SET NULL;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Garante que uma Devolução não pode ter dois RMAs "ativos"
-- simultaneamente (status fora de closed/rejected). Índice único
-- parcial — o jeito idiomático no Postgres de expressar essa regra.
CREATE UNIQUE INDEX IF NOT EXISTS uq_rma_active_per_return
  ON rma(return_id)
  WHERE return_id IS NOT NULL AND status NOT IN ('closed','rejected');

-- ── 5. Índices de apoio ────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_tickets_product_group ON tickets(product_group) WHERE product_group IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tickets_brand ON tickets(brand) WHERE brand IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_returns_inspection_status ON returns(inspection_status);
CREATE INDEX IF NOT EXISTS idx_rma_return_id ON rma(return_id) WHERE return_id IS NOT NULL;

-- ── 6. Correção de sequence dessincronizada (achado real) ──────
-- A renomeação histórica rma → rma_legacy (migration 004) deixou a
-- sequence real da tabela rma atual (rma_id_seq1) sem nunca ser
-- realinhada pelo seed.js, que sincronizava por engano a sequence
-- órfã da tabela antiga (rma_id_seq). Resultado: em qualquer
-- ambiente semeado antes desta correção, criar um RMA novo pela
-- tela podia falhar com "duplicate key value violates unique
-- constraint" na primeira tentativa. Este bloco realinha a
-- sequence real com o maior id já existente, em qualquer tabela
-- que tenha coluna serial — seguro de rodar múltiplas vezes.
DO $$
DECLARE
  seq_name text;
BEGIN
  seq_name := pg_get_serial_sequence('rma', 'id');
  IF seq_name IS NOT NULL THEN
    PERFORM setval(seq_name, GREATEST((SELECT COALESCE(MAX(id), 0) FROM rma), 1), true);
  END IF;
END $$;

-- ============================================================
-- Fim da migration 010.
-- ============================================================
