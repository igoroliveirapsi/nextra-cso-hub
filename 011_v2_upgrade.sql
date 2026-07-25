-- ═══════════════════════════════════════════════════════════════
-- 011_v2_upgrade.sql — Nextra CSO Hub v2.0 (one-shot upgrade)
-- Anexos reais, produto/garantia no RMA, horas úteis e feriados.
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

-- 1. Anexos genéricos (armazenados no próprio Postgres — sobrevivem a redeploys do Railway)
CREATE TABLE IF NOT EXISTS attachments (
  id          SERIAL PRIMARY KEY,
  entity_type VARCHAR(20)  NOT NULL CHECK (entity_type IN ('ticket','return','rma','complaint')),
  entity_id   VARCHAR(40)  NOT NULL,
  filename    VARCHAR(255) NOT NULL,
  mime        VARCHAR(120),
  size_bytes  INTEGER      NOT NULL,
  data        BYTEA        NOT NULL,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_attach_entity ON attachments(entity_type, entity_id);

-- 2. RMA passa a apontar para o catálogo de produtos + controle de garantia
ALTER TABLE rma     ADD COLUMN IF NOT EXISTS product_id     INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL;
ALTER TABLE rma     ADD COLUMN IF NOT EXISTS purchase_date  DATE;
ALTER TABLE rma     ADD COLUMN IF NOT EXISTS warranty_state VARCHAR(20);
ALTER TABLE returns ADD COLUMN IF NOT EXISTS product_id     INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL;

-- 3. Notificações ganham link de navegação para o módulo de origem
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS link_view VARCHAR(30);

-- 4. Horário comercial padrão (seg–sex, 08:00–18:00, global) — só se a tabela estiver vazia
INSERT INTO business_hours (business_unit_id, day_of_week, start_time, end_time, is_active)
SELECT NULL, d, '08:00'::time, '18:00'::time, TRUE
FROM generate_series(1,5) AS d
WHERE NOT EXISTS (SELECT 1 FROM business_hours);

-- 5. Feriados nacionais 2026 — só se a tabela estiver vazia
INSERT INTO holidays (business_unit_id, date, name)
SELECT NULL, f.d::date, f.n FROM (VALUES
  ('2026-01-01','Confraternização Universal'),
  ('2026-02-16','Carnaval'),
  ('2026-02-17','Carnaval'),
  ('2026-04-03','Sexta-feira Santa'),
  ('2026-04-21','Tiradentes'),
  ('2026-05-01','Dia do Trabalho'),
  ('2026-06-04','Corpus Christi'),
  ('2026-09-07','Independência do Brasil'),
  ('2026-10-12','Nossa Senhora Aparecida'),
  ('2026-11-02','Finados'),
  ('2026-11-15','Proclamação da República'),
  ('2026-11-20','Dia da Consciência Negra'),
  ('2026-12-25','Natal')
) AS f(d,n)
WHERE NOT EXISTS (SELECT 1 FROM holidays);
