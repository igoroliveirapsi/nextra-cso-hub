-- ══════════════════════════════════════════════════════════════
-- 004_full_version_1_0.sql  — Nextra CSO Hub Full Version 1.0
-- Adds: complaint_history, RMA, CSAT, NPS, Recovery Plans,
--       missing columns, Dashboard Views
-- Preserves: 001, 002, 003 tables/ENUMs/data
-- ══════════════════════════════════════════════════════════════
BEGIN;

-- ── 1. Add missing columns to complaints ─────────────────────
ALTER TABLE complaints
  ADD COLUMN IF NOT EXISTS responsible_user_id INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS closed_at           TIMESTAMPTZ;

-- ── 2. Complaint History (did not exist in 003) ───────────────
CREATE TABLE IF NOT EXISTS complaint_history (
  id           BIGSERIAL PRIMARY KEY,
  complaint_id INTEGER NOT NULL REFERENCES complaints(id) ON DELETE CASCADE,
  user_id      INTEGER REFERENCES users(id),
  action       VARCHAR(200) NOT NULL,
  old_status   complaint_status,
  new_status   complaint_status,
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ch_complaint ON complaint_history(complaint_id, created_at DESC);

-- Append-only
CREATE OR REPLACE FUNCTION prevent_complaint_history_mod() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'complaint_history is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_ch_immutable ON complaint_history;
CREATE TRIGGER trg_ch_immutable
  BEFORE UPDATE OR DELETE ON complaint_history
  FOR EACH ROW EXECUTE FUNCTION prevent_complaint_history_mod();

-- Auto closed_at when complaint is closed/cancelled
CREATE OR REPLACE FUNCTION set_complaint_closed_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('closed','cancelled') AND (OLD.status IS NULL OR OLD.status NOT IN ('closed','cancelled')) THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_complaint_closed_at ON complaints;
CREATE TRIGGER trg_complaint_closed_at
  BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_complaint_closed_at();

-- ── 3. Add old_status/new_status to return_history ────────────
ALTER TABLE return_history
  ADD COLUMN IF NOT EXISTS old_status return_status,
  ADD COLUMN IF NOT EXISTS new_status return_status;

-- ── 4. Add missing columns to returns ────────────────────────
ALTER TABLE returns
  ADD COLUMN IF NOT EXISTS reject_reason TEXT;



-- ── 4b. Add is_active to clients (needed for views below) ────
ALTER TABLE clients ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

-- ── 5. RMA Enums ─────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE rma_decision_v1 AS ENUM ('repair','replacement','credit','rejection');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE rma_status AS ENUM (
    'requested','under_analysis','awaiting_shipment','in_transit',
    'received','technical_analysis','awaiting_decision',
    'approved','repair','replacement','rejected','closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 6. RMA Full Version Table ────────────────────────────────
-- Rename the old legacy rma table and create a new operational one
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'rma' AND table_schema = 'public') THEN
    ALTER TABLE rma RENAME TO rma_legacy;
    RAISE NOTICE 'Renamed rma → rma_legacy';
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rma (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  business_unit_id      VARCHAR(10) REFERENCES business_units(id),
  ticket_id             VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  product_name          VARCHAR(200) NOT NULL,
  product_code          VARCHAR(100),
  serial_number         VARCHAR(100),
  defect_description    TEXT NOT NULL,
  warranty              BOOLEAN NOT NULL DEFAULT FALSE,
  status                rma_status NOT NULL DEFAULT 'requested',
  rma_decision_v1       rma_decision_v1,
  decision_notes        TEXT,
  technical_notes       TEXT,
  received_at           TIMESTAMPTZ,
  closed_at             TIMESTAMPTZ,
  responsible_user_id   INTEGER REFERENCES users(id),
  created_by_user_id    INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 7. RMA History ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS rma_history (
  id          BIGSERIAL PRIMARY KEY,
  rma_id      INTEGER NOT NULL REFERENCES rma(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  action      VARCHAR(200) NOT NULL,
  old_status  rma_status,
  new_status  rma_status,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_rmah_rma ON rma_history(rma_id, created_at DESC);

CREATE OR REPLACE FUNCTION prevent_rma_history_mod() RETURNS TRIGGER AS $$
BEGIN RAISE EXCEPTION 'rma_history is append-only'; END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_rmah_immutable ON rma_history;
CREATE TRIGGER trg_rmah_immutable
  BEFORE UPDATE OR DELETE ON rma_history
  FOR EACH ROW EXECUTE FUNCTION prevent_rma_history_mod();

DROP TRIGGER IF EXISTS trg_rma_updated ON rma;
CREATE TRIGGER trg_rma_updated
  BEFORE UPDATE ON rma
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- closed_at for RMA
CREATE OR REPLACE FUNCTION set_rma_closed_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status IN ('closed','rejected') AND (OLD.status IS NULL OR OLD.status NOT IN ('closed','rejected')) THEN
    NEW.closed_at = NOW();
  END IF;
  IF NEW.status = 'received' AND OLD.received_at IS NULL THEN
    NEW.received_at = NOW();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS trg_rma_closed_at ON rma;
CREATE TRIGGER trg_rma_closed_at
  BEFORE UPDATE ON rma
  FOR EACH ROW EXECUTE FUNCTION set_rma_closed_at();

-- ── 8. CSAT Table ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS csat (
  id               SERIAL PRIMARY KEY,
  client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  business_unit_id VARCHAR(10) REFERENCES business_units(id),
  ticket_id        VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  complaint_id     INTEGER REFERENCES complaints(id) ON DELETE SET NULL,
  score            SMALLINT NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment          TEXT,
  collected_by     INTEGER REFERENCES users(id),
  collection_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_csat_client ON csat(client_id);
CREATE INDEX IF NOT EXISTS idx_csat_date   ON csat(collection_date);

-- ── 9. NPS Table ──────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE nps_type AS ENUM ('detractor','neutral','promoter');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS nps (
  id               SERIAL PRIMARY KEY,
  client_id        INTEGER REFERENCES clients(id) ON DELETE CASCADE,
  business_unit_id VARCHAR(10) REFERENCES business_units(id),
  score            SMALLINT NOT NULL CHECK (score BETWEEN 0 AND 10),
  nps_type         nps_type NOT NULL GENERATED ALWAYS AS (
    CASE WHEN score >= 9 THEN 'promoter'::nps_type WHEN score >= 7 THEN 'neutral'::nps_type ELSE 'detractor'::nps_type END
  ) STORED,
  comment          TEXT,
  collected_by     INTEGER REFERENCES users(id),
  collection_date  DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nps_client ON nps(client_id);

-- ── 10. Recovery Plans ────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE recovery_status AS ENUM ('open','in_progress','awaiting_client','completed','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recovery_plans (
  id                    SERIAL PRIMARY KEY,
  client_id             INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  business_unit_id      VARCHAR(10) REFERENCES business_units(id),
  status                recovery_status NOT NULL DEFAULT 'open',
  reason                TEXT NOT NULL,
  responsible_user_id   INTEGER REFERENCES users(id),
  expected_result       TEXT,
  final_result          TEXT,
  health_score_at_open  SMALLINT,
  target_health_score   SMALLINT DEFAULT 70,
  next_review_date      DATE,
  completed_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_by_user_id    INTEGER REFERENCES users(id),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Extend recovery_plans if it already existed with different schema (from 001)
ALTER TABLE recovery_plans
  ADD COLUMN IF NOT EXISTS business_unit_id     VARCHAR(10),
  ADD COLUMN IF NOT EXISTS reason               TEXT,
  ADD COLUMN IF NOT EXISTS expected_result      TEXT,
  ADD COLUMN IF NOT EXISTS health_score_at_open SMALLINT,
  ADD COLUMN IF NOT EXISTS target_health_score  SMALLINT DEFAULT 70,
  ADD COLUMN IF NOT EXISTS next_review_date     DATE,
  ADD COLUMN IF NOT EXISTS cancelled_at         TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_by_user_id   INTEGER REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_rp_client ON recovery_plans(client_id);
CREATE INDEX IF NOT EXISTS idx_rp_status ON recovery_plans(status);

DROP TRIGGER IF EXISTS trg_rp_updated ON recovery_plans;
CREATE TRIGGER trg_rp_updated
  BEFORE UPDATE ON recovery_plans
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── 11. Recovery Actions ──────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE action_status AS ENUM ('pending','in_progress','done','cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS recovery_actions (
  id               SERIAL PRIMARY KEY,
  recovery_plan_id INTEGER NOT NULL REFERENCES recovery_plans(id) ON DELETE CASCADE,
  description      TEXT NOT NULL,
  responsible      VARCHAR(200),
  due_date         DATE,
  status           action_status NOT NULL DEFAULT 'pending',
  completed_at     TIMESTAMPTZ,
  notes            TEXT,
  sort_order       SMALLINT DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── 12. Add missing columns to clients ───────────────────────
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS phone  VARCHAR(30),
  ADD COLUMN IF NOT EXISTS email  VARCHAR(200),
  ADD COLUMN IF NOT EXISTS notes  TEXT;

-- ── 13. Dashboard Views ───────────────────────────────────────
CREATE OR REPLACE VIEW view_executive_dashboard AS
WITH ts AS (
  SELECT
    COUNT(*) FILTER (WHERE status NOT IN ('closed')) AS open_tickets,
    COUNT(*) FILTER (WHERE sla_state = 'overdue' AND status NOT IN ('closed')) AS sla_overdue,
    COUNT(*) FILTER (WHERE sla_state = 'warn' AND status NOT IN ('closed')) AS sla_warn,
    COUNT(*) FILTER (WHERE criticality = 'critical' AND status NOT IN ('closed')) AS critical_tickets,
    COALESCE(SUM(revenue_at_risk) FILTER (WHERE status NOT IN ('closed')), 0) AS total_revenue_at_risk,
    AVG(EXTRACT(EPOCH FROM (NOW()-created_at))/86400) FILTER (WHERE status NOT IN ('closed')) AS avg_aging_days
  FROM tickets
),
cs AS (
  SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','cancelled')) AS open_complaints,
         COUNT(*) FILTER (WHERE severity='critical' AND status NOT IN ('closed','cancelled')) AS critical_complaints
  FROM complaints
),
rs AS (SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected')) AS open_returns FROM returns),
rm AS (SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected')) AS open_rmas FROM rma),
ch AS (
  SELECT COUNT(*) FILTER (WHERE health_status IN ('at_risk','critical') AND is_active) AS clients_at_risk,
         COUNT(*) FILTER (WHERE health_status = 'critical' AND is_active) AS clients_critical,
         COUNT(*) FILTER (WHERE health_status = 'recovered' AND is_active) AS clients_recovered
  FROM clients
),
ct AS (SELECT ROUND(AVG(score)::NUMERIC,1) AS csat_avg FROM csat WHERE collection_date >= CURRENT_DATE - 30)
SELECT ts.open_tickets, ts.sla_overdue, ts.sla_warn, ts.critical_tickets,
       ts.total_revenue_at_risk, ROUND(ts.avg_aging_days::NUMERIC,1) AS avg_aging_days,
       cs.open_complaints, cs.critical_complaints,
       rs.open_returns, rm.open_rmas,
       ch.clients_at_risk, ch.clients_critical, ch.clients_recovered,
       ct.csat_avg
FROM ts, cs, rs, rm, ch, ct;

CREATE OR REPLACE VIEW view_control_tower AS
SELECT
  (SELECT json_agg(t) FROM (SELECT id,client_name,status,criticality,sla_state,description,revenue_at_risk,created_at FROM tickets WHERE criticality='critical' AND status NOT IN ('closed') ORDER BY created_at) t) AS critical_tickets,
  (SELECT json_agg(t) FROM (SELECT id,client_name,status,criticality,sla_state,description,sla_deadline FROM tickets WHERE sla_state='overdue' AND status NOT IN ('closed') ORDER BY sla_deadline) t) AS sla_overdue,
  (SELECT json_agg(t) FROM (SELECT id,client_name,status,description,created_at FROM tickets WHERE status='new' ORDER BY created_at) t) AS no_owner_tickets,
  (SELECT json_agg(t) FROM (SELECT id,client_name,status,approval_status,description FROM tickets WHERE status='resolved' AND approval_status='pending' ORDER BY created_at) t) AS pending_approval,
  (SELECT json_agg(c) FROM (SELECT id,client_id,type_key,severity,status,reason AS description,loss_risk,created_at FROM complaints WHERE severity='critical' AND status NOT IN ('closed','cancelled') ORDER BY created_at) c) AS critical_complaints,
  (SELECT json_agg(r) FROM (SELECT id,client_id,status,reason,total_value,created_at FROM returns WHERE status IN ('awaiting_approval','awaiting_fiscal') ORDER BY created_at) r) AS blocked_returns,
  (SELECT json_agg(r) FROM (SELECT id,client_id,status,product_name,defect_description,created_at FROM rma WHERE status IN ('awaiting_decision','received') ORDER BY created_at) r) AS stuck_rmas;

CREATE OR REPLACE VIEW view_area_ranking AS
SELECT area_responsible AS area,
       COUNT(*) AS ticket_count,
       COUNT(*) FILTER (WHERE criticality='critical') AS critical_count,
       COALESCE(SUM(revenue_at_risk),0) AS total_revenue_at_risk
FROM tickets WHERE created_at >= NOW() - INTERVAL '90 days'
GROUP BY area_responsible ORDER BY ticket_count DESC;

CREATE OR REPLACE VIEW view_client_ranking AS
SELECT c.id, c.name, c.health_status, c.health_score,
       COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('closed')) AS open_tickets,
       COUNT(DISTINCT comp.id) FILTER (WHERE comp.status NOT IN ('closed','cancelled')) AS open_complaints,
       COALESCE(SUM(DISTINCT t.revenue_at_risk) FILTER (WHERE t.status NOT IN ('closed')), 0) AS total_revenue_at_risk,
       c.csat_avg
FROM clients c
LEFT JOIN tickets    t    ON t.client_id    = c.id
LEFT JOIN complaints comp ON comp.client_id = c.id
WHERE c.is_active = TRUE
GROUP BY c.id 
ORDER BY COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('closed')) + 
         COUNT(DISTINCT comp.id) FILTER (WHERE comp.status NOT IN ('closed','cancelled')) DESC;

-- ── 14. Verification ─────────────────────────────────────────
DO $$
DECLARE tbls TEXT[] := ARRAY['rma','rma_history','csat','nps','recovery_plans','recovery_actions','complaint_history'];
        tbl TEXT; cnt INT;
BEGIN
  FOREACH tbl IN ARRAY tbls LOOP
    SELECT COUNT(*) INTO cnt FROM information_schema.tables WHERE table_name=tbl AND table_schema='public';
    IF cnt = 0 THEN RAISE EXCEPTION 'Table % not found', tbl; END IF;
    RAISE NOTICE '✓ %', tbl;
  END LOOP;
  RAISE NOTICE '✓ Migration 004 verified OK';
END $$;

COMMIT;
