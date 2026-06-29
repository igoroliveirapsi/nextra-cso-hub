-- ============================================================
-- NEXTRA CSO HUB — Customer Success Layer
-- Migration:  003_cs_layer_v2.1.sql  (final)
-- Depends on: 001_schema.sql, 002_seeds.sql
-- PostgreSQL:  16+
-- Idempotent:  YES for clean DB — see note below for v2.0 upgrades
--
-- Corrections applied:
--   FIX-1  returns trigger added to recalc_client_health (was missing)
--   FIX-2  set_return_closed_at fires on 'rejected' too (not just 'closed')
--   FIX-3  single immutability function prevent_append_only_modification()
--   FIX-4  health_status='recovered' preserved when score >= 60
--   FIX-5  rejected returns penalty windowed to 180 days (not indefinite)
--          + NULL-safe handling for legacy data (closed_at may be NULL)
--   FIX-A  mark_client_recovered(): removed impossible status check
--          (status IN at_risk/critical AND score >= 60 is unreachable by design)
--          Replaced with: score >= 60 + evidence of past at_risk/critical
--          (client_health_log last 90d OR completed recovery_plan)
--          + ALREADY_RECOVERED guard to prevent double-marking
--
-- IMPORTANT — idempotency note for v2.0 upgrades:
--   This migration assumes the CS tables do NOT yet exist.
--   If v2.0 was already applied in production (complaints table exists
--   with status VARCHAR), run the upgrade script below BEFORE this file:
--
--   -- 003a_upgrade_v20_to_v21.sql (run only if v2.0 was applied):
--   /*
--   DO $$ BEGIN
--     IF EXISTS (
--       SELECT 1 FROM information_schema.columns
--       WHERE table_name = 'complaints' AND column_name = 'status'
--         AND data_type = 'character varying'
--     ) THEN
--       CREATE TYPE complaint_status AS ENUM (
--         'open','in_progress','awaiting_client','resolved','closed','cancelled'
--       );
--       ALTER TABLE complaints
--         ALTER COLUMN status TYPE complaint_status
--         USING status::complaint_status;
--       ALTER TABLE complaints ALTER COLUMN status SET DEFAULT 'open';
--       RAISE NOTICE 'complaints.status converted VARCHAR → complaint_status ENUM';
--     END IF;
--   END $$;
--   */
-- ============================================================

BEGIN;

-- ════════════════════════════════════════════════════════════
-- BLOCK 1 — ENUMs (idempotent via DO/EXCEPTION)
-- ════════════════════════════════════════════════════════════

DO $$ BEGIN
  CREATE TYPE complaint_severity AS ENUM (
    'critical', 'high', 'medium', 'low'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE complaint_feeling AS ENUM (
    'very_upset', 'upset', 'neutral', 'satisfied', 'very_satisfied'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE complaint_procedence AS ENUM (
    'valid', 'partially_valid', 'invalid', 'under_analysis'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- complaint_status: was VARCHAR in v2.0, now ENUM
DO $$ BEGIN
  CREATE TYPE complaint_status AS ENUM (
    'open',              -- Aberta (estado inicial)
    'in_progress',       -- Em andamento
    'awaiting_client',   -- Aguardando cliente
    'resolved',          -- Resolvida (CSAT pode ser coletado)
    'closed',            -- Encerrada
    'cancelled'          -- Cancelada
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_status AS ENUM (
    'return_requested',
    'under_review',
    'awaiting_approval',
    'approved',
    'rejected',
    'awaiting_customer_shipment',
    'in_transit',
    'received',
    'under_inspection',
    'awaiting_fiscal',
    'awaiting_credit',
    'replacement_sent',
    'refund_or_credit_issued',
    'closed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE return_decision AS ENUM (
    'credit', 'swap', 'replacement', 'refund', 'discount', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE health_status AS ENUM (
    'healthy', 'attention', 'at_risk', 'critical', 'recovered'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ════════════════════════════════════════════════════════════
-- BLOCK 2 — Immutability function (FIX-3: standardized name)
-- ════════════════════════════════════════════════════════════

-- Single function for all append-only tables:
--   ticket_history, audit_log, client_health_log, return_history
--
-- NOTE: ticket_history and audit_log were created in 001_schema.sql
-- with the function prevent_modification(). Those triggers are NOT
-- changed here to avoid breaking the existing schema.
-- new tables (client_health_log, return_history) use the new name.

CREATE OR REPLACE FUNCTION prevent_append_only_modification()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION
    '% is append-only: % operation is not permitted.',
    TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════
-- BLOCK 3 — complaint_type_config
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS complaint_type_config (
  id           SERIAL PRIMARY KEY,
  type_key     VARCHAR(100) NOT NULL UNIQUE,
  label_pt     VARCHAR(255) NOT NULL,
  default_area user_role NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

INSERT INTO complaint_type_config(type_key, label_pt, default_area, sort_order) VALUES
  ('delayed_delivery',         'Atraso na entrega',                  'warehouse',  1),
  ('poor_service',             'Atendimento insatisfatório',          'cso',        2),
  ('product_quality',          'Qualidade do produto',                'support',    3),
  ('wrong_spec',               'Especificação incorreta',             'sales',      4),
  ('billing_error',            'Erro de cobrança',                    'fiscal',     5),
  ('missing_support',          'Suporte técnico ausente',             'support',    6),
  ('broken_promise',           'Promessa não cumprida',               'sales',      7),
  ('communication_failure',    'Falha de comunicação',                'cso',        8),
  ('product_not_as_expected',  'Produto diferente do esperado',       'sales',      9),
  ('installation_problem',     'Problema na instalação',              'support',   10),
  ('commercial_complaint',     'Reclamação comercial geral',          'sales',     11),
  ('other',                    'Outro',                               'cso',       12)
ON CONFLICT (type_key) DO NOTHING;

-- ════════════════════════════════════════════════════════════
-- BLOCK 4 — complaints  (status = complaint_status ENUM)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS complaints (
  id               SERIAL PRIMARY KEY,
  -- optional link to an existing ticket (same client_id required)
  ticket_id        VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  business_unit_id VARCHAR(10) NOT NULL REFERENCES business_units(id),
  -- classification
  type_key         VARCHAR(100) NOT NULL, -- logical FK to complaint_type_config.type_key
  severity         complaint_severity NOT NULL,
  channel          channel_type,
  -- content
  reason           TEXT NOT NULL,
  client_feeling   complaint_feeling,
  -- accountability
  causing_area     user_role,            -- optional; sensitive field
  responsible_area user_role NOT NULL,
  -- assessment
  procedence       complaint_procedence,
  commercial_impact TEXT,
  loss_risk        NUMERIC(15,2),
  -- resolution
  recovery_action  TEXT,
  resolution       TEXT,
  status           complaint_status NOT NULL DEFAULT 'open',  -- ENUM, not VARCHAR
  -- CSAT: collected only after status = resolved or closed
  csat_score       SMALLINT CHECK (csat_score BETWEEN 1 AND 5),
  csat_collected_at TIMESTAMPTZ,
  -- timestamps
  resolved_at      TIMESTAMPTZ,
  created_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_complaints_client
  ON complaints(client_id);
CREATE INDEX IF NOT EXISTS idx_complaints_status
  ON complaints(status);
CREATE INDEX IF NOT EXISTS idx_complaints_severity
  ON complaints(severity);
CREATE INDEX IF NOT EXISTS idx_complaints_bu
  ON complaints(business_unit_id);
CREATE INDEX IF NOT EXISTS idx_complaints_ticket
  ON complaints(ticket_id);
-- Partial index for performance on open/active complaints
CREATE INDEX IF NOT EXISTS idx_complaints_active
  ON complaints(client_id, status)
  WHERE status NOT IN ('closed', 'cancelled');

DROP TRIGGER IF EXISTS trg_complaints_upd ON complaints;
CREATE TRIGGER trg_complaints_upd
  BEFORE UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ════════════════════════════════════════════════════════════
-- BLOCK 5 — returns
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS returns (
  id               SERIAL PRIMARY KEY,
  ticket_id        VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  client_id        INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  business_unit_id VARCHAR(10) NOT NULL REFERENCES business_units(id),
  -- request
  reason           TEXT NOT NULL,
  order_number     VARCHAR(100),
  nf_number        VARCHAR(100),
  -- product
  product_catalog_id INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL,
  product_name_snap  VARCHAR(255),
  quantity           INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_value         NUMERIC(15,2),
  total_value        NUMERIC(15,2) GENERATED ALWAYS AS (
    CASE WHEN unit_value IS NOT NULL THEN quantity * unit_value ELSE NULL END
  ) STORED,
  product_condition  VARCHAR(50), -- new | used | damaged | sealed
  -- four independent status dimensions
  fiscal_status    VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending | in_analysis | processed | blocked
  logistics_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending | awaiting_shipment | in_transit | received
  financial_status VARCHAR(50) NOT NULL DEFAULT 'pending',
  -- pending | approved | issued | rejected
  -- overall flow status (14 enum values)
  status           return_status NOT NULL DEFAULT 'return_requested',
  -- decision
  decision         return_decision,
  decision_notes   TEXT,
  -- dates
  requested_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  received_at      TIMESTAMPTZ,
  closed_at        TIMESTAMPTZ,
  -- audit
  responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_returns_client  ON returns(client_id);
CREATE INDEX IF NOT EXISTS idx_returns_status  ON returns(status);
CREATE INDEX IF NOT EXISTS idx_returns_bu      ON returns(business_unit_id);
CREATE INDEX IF NOT EXISTS idx_returns_ticket  ON returns(ticket_id);
CREATE INDEX IF NOT EXISTS idx_returns_active
  ON returns(status)
  WHERE status NOT IN ('closed', 'rejected', 'refund_or_credit_issued');

DROP TRIGGER IF EXISTS trg_returns_upd ON returns;
CREATE TRIGGER trg_returns_upd
  BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION set_return_closed_at() RETURNS TRIGGER AS $$
BEGIN
  -- FIX-2: fire on BOTH 'closed' and 'rejected' status transitions.
  -- Without this, returns.closed_at would remain NULL on rejection,
  -- causing the 180-day window check in recalc_client_health() to
  -- evaluate NULL >= NOW()-180d → NULL → no penalty (wrong behaviour).
  IF NEW.status IN ('closed', 'rejected') AND OLD.status <> NEW.status THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_return_closed_at ON returns;
CREATE TRIGGER trg_return_closed_at
  BEFORE UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION set_return_closed_at();

-- ════════════════════════════════════════════════════════════
-- BLOCK 6 — return_history  (append-only, FIX-3)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS return_history (
  id            BIGSERIAL PRIMARY KEY,
  return_id     INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(255) NOT NULL,
  field_changed VARCHAR(100),
  old_value     TEXT,
  new_value     TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — this table is append-only
);

CREATE INDEX IF NOT EXISTS idx_rh_return
  ON return_history(return_id, created_at DESC);

DROP TRIGGER IF EXISTS trg_return_history_immutable ON return_history;
CREATE TRIGGER trg_return_history_immutable
  BEFORE UPDATE OR DELETE ON return_history
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_modification();

-- ════════════════════════════════════════════════════════════
-- BLOCK 7 — client_health_log  (append-only, FIX-3)
-- ════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS client_health_log (
  id            SERIAL PRIMARY KEY,
  client_id     INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  health_score  INTEGER NOT NULL CHECK (health_score BETWEEN 0 AND 100),
  health_status health_status NOT NULL,
  delta         INTEGER,       -- change from previous score
  reason        VARCHAR(500),  -- what triggered the recalculation
  recorded_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at — this table is append-only
);

CREATE INDEX IF NOT EXISTS idx_health_log_client
  ON client_health_log(client_id, recorded_at DESC);

DROP TRIGGER IF EXISTS trg_health_log_immutable ON client_health_log;
CREATE TRIGGER trg_health_log_immutable
  BEFORE UPDATE OR DELETE ON client_health_log
  FOR EACH ROW EXECUTE FUNCTION prevent_append_only_modification();

-- ════════════════════════════════════════════════════════════
-- BLOCK 8 — ALTER TABLE clients
-- ════════════════════════════════════════════════════════════

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS health_score            INTEGER      NOT NULL DEFAULT 100,
  ADD COLUMN IF NOT EXISTS health_status           health_status NOT NULL DEFAULT 'healthy',
  ADD COLUMN IF NOT EXISTS csat_avg                NUMERIC(3,1),
  ADD COLUMN IF NOT EXISTS last_purchase_date      DATE,
  ADD COLUMN IF NOT EXISTS total_revenue_at_risk   NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_revenue_protected NUMERIC(15,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS recurrence_count        INTEGER       NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS idx_clients_health_status
  ON clients(health_status);
CREATE INDEX IF NOT EXISTS idx_clients_csat
  ON clients(csat_avg) WHERE csat_avg IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_clients_health_score
  ON clients(health_score ASC);  -- useful for at-risk queries

-- ════════════════════════════════════════════════════════════
-- BLOCK 9 — ALTER TABLE recovery_plans
-- ════════════════════════════════════════════════════════════

ALTER TABLE recovery_plans
  ADD COLUMN IF NOT EXISTS complaint_id         INTEGER REFERENCES complaints(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS return_id            INTEGER REFERENCES returns(id)     ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS next_update_date     DATE,
  ADD COLUMN IF NOT EXISTS client_communication TEXT,
  ADD COLUMN IF NOT EXISTS leadership_notes     TEXT,
  ADD COLUMN IF NOT EXISTS final_result         TEXT;

-- ════════════════════════════════════════════════════════════
-- BLOCK 10 — recalc_client_health() v2.1
--
-- FIXES APPLIED:
--   FIX-1: returns now included in penalty calculation
--   FIX-4: health_status='recovered' preserved when score >= 60
--   FIX-5: rejected returns penalty windowed to 180 days
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recalc_client_health(p_client_id INTEGER)
RETURNS VOID AS $$
DECLARE
  v_old_score      INTEGER;
  v_current_status health_status;
  v_last_purchase  DATE;

  v_comp_penalty   INTEGER := 0;
  v_csat_penalty   INTEGER := 0;
  v_sla_penalty    INTEGER := 0;
  v_recur_penalty  INTEGER := 0;
  v_ret_penalty    INTEGER := 0;  -- FIX-1: now populated
  v_rev_penalty    INTEGER := 0;
  v_time_penalty   INTEGER := 0;
  v_recovery_bonus INTEGER := 0;

  v_new_score      INTEGER;
  v_new_status     health_status;
BEGIN
  IF p_client_id IS NULL THEN RETURN; END IF;

  SELECT health_score, health_status, last_purchase_date
  INTO   v_old_score, v_current_status, v_last_purchase
  FROM   clients
  WHERE  id = p_client_id;

  -- ── COMPLAINT PENALTY ──────────────────────────────────────
  -- Active (non-closed, non-cancelled) open complaints only
  SELECT COALESCE(SUM(
    CASE severity
      WHEN 'critical' THEN 15
      WHEN 'high'     THEN  8
      WHEN 'medium'   THEN  4
      ELSE                  2
    END
  ), 0)
  INTO v_comp_penalty
  FROM complaints
  WHERE client_id = p_client_id
    AND status NOT IN ('closed', 'cancelled', 'resolved');

  -- ── CSAT PENALTY ───────────────────────────────────────────
  -- Low CSAT collected in the last 180 days
  SELECT COALESCE(SUM(
    CASE
      WHEN csat_score < 3 THEN 10
      WHEN csat_score < 4 THEN  5
      ELSE                      0
    END
  ), 0)
  INTO v_csat_penalty
  FROM complaints
  WHERE client_id = p_client_id
    AND csat_score IS NOT NULL
    AND csat_collected_at >= NOW() - INTERVAL '180 days';

  -- ── SLA PENALTY ────────────────────────────────────────────
  -- Active tickets with deadline already exceeded
  SELECT COALESCE(COUNT(*) * 5, 0)
  INTO v_sla_penalty
  FROM tickets
  WHERE client_id = p_client_id
    AND status NOT IN ('closed', 'resolved')
    AND NOW() > sla_deadline
    AND NOT sla_paused;

  -- ── RECURRENCE PENALTY ─────────────────────────────────────
  SELECT COALESCE(COUNT(*) * 8, 0)
  INTO v_recur_penalty
  FROM tickets
  WHERE client_id = p_client_id
    AND is_recurrence = TRUE
    AND status NOT IN ('closed', 'resolved');

  -- ── RETURN PENALTY (FIX-1 + FIX-5 + NULL-safe) ──────────────
  -- FIX-1: returns was NOT included in v2.0 — now it is.
  -- FIX-5: rejected returns penalise only within last 180 days.
  -- NULL-safe: if closed_at IS NULL (data before this migration ran),
  --            treat as "within window" to avoid silently dropping penalty.
  --            After FIX-2 lands, all new rejections will have closed_at set.
  SELECT COALESCE(SUM(
    CASE
      WHEN status = 'rejected'
       AND (closed_at IS NULL
            OR closed_at >= NOW() - INTERVAL '180 days') THEN 10  -- windowed + legacy-safe
      WHEN status NOT IN (
             'closed', 'rejected', 'refund_or_credit_issued'
           )                                              THEN  5  -- active return
      ELSE                                                       0
    END
  ), 0)
  INTO v_ret_penalty
  FROM returns
  WHERE client_id = p_client_id;

  -- ── REVENUE AT RISK PENALTY ────────────────────────────────
  SELECT COALESCE(SUM(
    CASE WHEN revenue_at_risk > 50000 THEN 10 ELSE 0 END
  ), 0)
  INTO v_rev_penalty
  FROM tickets
  WHERE client_id = p_client_id
    AND status NOT IN ('closed', 'resolved');

  -- ── TIME WITHOUT PURCHASE PENALTY ─────────────────────────
  -- Triggered by cron job; cannot be triggered by DB event.
  IF v_last_purchase IS NOT NULL THEN
    IF    v_last_purchase < CURRENT_DATE - INTERVAL '180 days' THEN v_time_penalty := 30;
    ELSIF v_last_purchase < CURRENT_DATE - INTERVAL  '90 days' THEN v_time_penalty := 10;
    END IF;
  END IF;

  -- ── RECOVERY BONUS ─────────────────────────────────────────
  SELECT COALESCE(COUNT(*) * 5, 0)
  INTO v_recovery_bonus
  FROM recovery_plans
  WHERE client_id = p_client_id
    AND status IN ('pending', 'in_progress');

  -- ── FINAL SCORE (clamped 0–100) ────────────────────────────
  v_new_score := GREATEST(0, LEAST(100,
      100
    - v_comp_penalty
    - v_csat_penalty
    - v_sla_penalty
    - v_recur_penalty
    - v_ret_penalty
    - v_rev_penalty
    - v_time_penalty
    + v_recovery_bonus
  ));

  -- ── HEALTH STATUS (FIX-4) ──────────────────────────────────
  -- FIX-4: if CSO already confirmed 'recovered', do NOT overwrite
  --        it back to 'healthy' or 'attention' automatically.
  --        Only downgrade if score falls below 60.
  IF v_current_status = 'recovered' AND v_new_score >= 60 THEN
    -- Keep the confirmed recovery status
    v_new_status := 'recovered';
  ELSE
    -- Standard thresholds
    v_new_status := CASE
      WHEN v_new_score >= 80 THEN 'healthy'::health_status
      WHEN v_new_score >= 60 THEN 'attention'::health_status
      WHEN v_new_score >= 40 THEN 'at_risk'::health_status
      ELSE                        'critical'::health_status
    END;
  END IF;

  -- ── PERSIST + LOG ─────────────────────────────────────────
  UPDATE clients
  SET    health_score  = v_new_score,
         health_status = v_new_status,
         updated_at    = NOW()
  WHERE  id = p_client_id;

  -- Only log when score actually changes (avoids log spam)
  IF v_new_score IS DISTINCT FROM v_old_score THEN
    INSERT INTO client_health_log
      (client_id, health_score, health_status, delta, reason)
    VALUES
      (p_client_id, v_new_score, v_new_status,
       v_new_score - COALESCE(v_old_score, 100),
       'Auto-recalculated by trigger');
  END IF;
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════
-- BLOCK 11 — recalc_client_csat()
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION recalc_client_csat(p_client_id INTEGER)
RETURNS VOID AS $$
BEGIN
  UPDATE clients
  SET    csat_avg   = (
           SELECT ROUND(AVG(csat_score)::NUMERIC, 1)
           FROM   complaints
           WHERE  client_id = p_client_id
             AND  csat_score IS NOT NULL
             AND  csat_collected_at >= NOW() - INTERVAL '180 days'
         ),
         updated_at = NOW()
  WHERE  id = p_client_id;
END;
$$ LANGUAGE plpgsql;
-- Called explicitly by the backend after PATCH /complaints/:id/csat succeeds.
-- Not a trigger — explicit call avoids redundant recalculation.

-- ════════════════════════════════════════════════════════════
-- BLOCK 12 — mark_client_recovered()
-- ════════════════════════════════════════════════════════════
--
-- FIX-A (mandatory): Previous logic required health_status IN ('at_risk','critical')
-- AND health_score >= 60. This is a logical impossibility under normal thresholds:
--   score >= 60 → status becomes 'attention' or 'healthy' (not at_risk/critical).
-- A client whose issues were resolved will have score >= 60 AND status 'attention',
-- making the old condition permanently unreachable.
--
-- Corrected conditions:
--   1. health_score >= 60     (score shows improvement)
--   2. NOT already 'recovered'  (prevent double-marking)
--   3. Evidence of past at_risk/critical:
--        a. client_health_log has at_risk/critical entry in last 90 days, OR
--        b. a recovery_plan for this client is completed (status = 'done')
--   4. reason >= 20 characters  (documents the evidence)

CREATE OR REPLACE FUNCTION mark_client_recovered(
  p_client_id INTEGER,
  p_user_id   INTEGER,
  p_reason    TEXT
) RETURNS VOID AS $$
DECLARE
  v_score         INTEGER;
  v_status        health_status;
  v_has_evidence  BOOLEAN;
BEGIN
  SELECT health_score, health_status
  INTO   v_score, v_status
  FROM   clients WHERE id = p_client_id;

  -- Guard 1: client must not already be recovered
  IF v_status = 'recovered' THEN
    RAISE EXCEPTION 'ALREADY_RECOVERED: cliente já está com status recovered.';
  END IF;

  -- Guard 2: score must be >= 60 (confirms actual improvement)
  IF v_score < 60 THEN
    RAISE EXCEPTION
      'SCORE_TOO_LOW: score atual % está abaixo do mínimo 60 para recovered.', v_score;
  END IF;

  -- Guard 3: must have verifiable evidence of past at_risk/critical
  -- (a) recent log entry within 90 days, OR (b) completed recovery plan
  SELECT (
    EXISTS(
      SELECT 1 FROM client_health_log
      WHERE client_id  = p_client_id
        AND health_status IN ('at_risk', 'critical')
        AND recorded_at >= NOW() - INTERVAL '90 days'
    )
    OR
    EXISTS(
      SELECT 1 FROM recovery_plans
      WHERE client_id = p_client_id
        AND status    = 'done'
    )
  ) INTO v_has_evidence;

  IF NOT v_has_evidence THEN
    RAISE EXCEPTION
      'NO_RECOVERY_EVIDENCE: cliente não tem histórico de at_risk/critical '
      'nos últimos 90 dias nem plano de recuperação concluído. '
      'mark-recovered destina-se apenas a clientes que se recuperaram '
      'de uma situação de risco confirmada.';
  END IF;

  -- Guard 4: reason must be meaningful
  IF LENGTH(TRIM(COALESCE(p_reason, ''))) < 20 THEN
    RAISE EXCEPTION 'REASON_TOO_SHORT: reason deve ter mínimo 20 caracteres.';
  END IF;

  -- Mark as recovered
  UPDATE clients
  SET    health_status = 'recovered',
         updated_at    = NOW()
  WHERE  id = p_client_id;

  -- Append to immutable log
  INSERT INTO client_health_log
    (client_id, health_score, health_status, delta, reason)
  VALUES
    (p_client_id, v_score, 'recovered', 0,
     'MANUAL RECOVERY by user_id=' || p_user_id || ': ' || p_reason);
END;
$$ LANGUAGE plpgsql;

-- ════════════════════════════════════════════════════════════
-- BLOCK 13 — validate_complaint_transition()
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION validate_complaint_transition(
  p_from complaint_status,
  p_to   complaint_status
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN CASE p_from
    WHEN 'open'            THEN p_to IN ('in_progress', 'awaiting_client', 'cancelled')
    WHEN 'in_progress'     THEN p_to IN ('awaiting_client', 'resolved', 'cancelled')
    WHEN 'awaiting_client' THEN p_to IN ('in_progress', 'resolved', 'closed')
    WHEN 'resolved'        THEN p_to IN ('closed', 'open')   -- reopen allowed
    WHEN 'closed'          THEN FALSE                         -- terminal
    WHEN 'cancelled'       THEN FALSE                         -- terminal
    ELSE FALSE
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ════════════════════════════════════════════════════════════
-- BLOCK 14 — validate_return_transition()
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION validate_return_transition(
  p_from return_status,
  p_to   return_status
) RETURNS BOOLEAN AS $$
BEGIN
  RETURN CASE p_from
    WHEN 'return_requested'            THEN p_to IN ('under_review', 'rejected')
    WHEN 'under_review'                THEN p_to IN ('awaiting_approval', 'rejected')
    WHEN 'awaiting_approval'           THEN p_to IN ('approved', 'rejected')
    WHEN 'approved'                    THEN p_to IN ('awaiting_customer_shipment')
    WHEN 'awaiting_customer_shipment'  THEN p_to IN ('in_transit', 'rejected')
    WHEN 'in_transit'                  THEN p_to IN ('received')
    WHEN 'received'                    THEN p_to IN ('under_inspection')
    WHEN 'under_inspection'            THEN p_to IN ('awaiting_fiscal', 'replacement_sent', 'rejected')
    WHEN 'awaiting_fiscal'             THEN p_to IN ('awaiting_credit', 'replacement_sent')
    WHEN 'awaiting_credit'             THEN p_to IN ('refund_or_credit_issued')
    WHEN 'replacement_sent'            THEN p_to IN ('closed')
    WHEN 'refund_or_credit_issued'     THEN p_to IN ('closed')
    WHEN 'rejected'                    THEN FALSE   -- terminal
    WHEN 'closed'                      THEN FALSE   -- terminal
    ELSE FALSE
  END;
END;
$$ LANGUAGE plpgsql IMMUTABLE;

-- ════════════════════════════════════════════════════════════
-- BLOCK 15 — Health score triggers (6 tables)
--
-- Trigger functions are separate per table for clarity.
-- 001_schema.sql already has trg_tickets_recalc_risk (risk score).
-- We add new, separate triggers for health score.
-- ════════════════════════════════════════════════════════════

-- 15.1  tickets → health
CREATE OR REPLACE FUNCTION trg_fn_tickets_health() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_health(COALESCE(NEW.client_id, OLD.client_id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tickets_health ON tickets;
CREATE TRIGGER trg_tickets_health
  AFTER INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION trg_fn_tickets_health();

-- 15.2  sla_events trigger removed — table not in base schema (001_schema.sql).
--        Health score SLA recalculation is handled by trg_tickets_health ON tickets,
--        which reads sla_deadline and sla_paused columns directly.

-- 15.3  rma → health
CREATE OR REPLACE FUNCTION trg_fn_rma_health() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_health(
    (SELECT client_id FROM tickets
     WHERE id = COALESCE(NEW.ticket_id, OLD.ticket_id))
  );
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_rma_health ON rma;
CREATE TRIGGER trg_rma_health
  AFTER INSERT OR UPDATE ON rma
  FOR EACH ROW EXECUTE FUNCTION trg_fn_rma_health();

-- 15.4  complaints → health
CREATE OR REPLACE FUNCTION trg_fn_complaints_health() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_health(COALESCE(NEW.client_id, OLD.client_id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_complaints_health ON complaints;
CREATE TRIGGER trg_complaints_health
  AFTER INSERT OR UPDATE ON complaints
  FOR EACH ROW EXECUTE FUNCTION trg_fn_complaints_health();

-- 15.5  returns → health  (FIX-1: was missing from v2.0)
CREATE OR REPLACE FUNCTION trg_fn_returns_health() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_health(COALESCE(NEW.client_id, OLD.client_id));
  RETURN NEW;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_returns_health ON returns;
CREATE TRIGGER trg_returns_health
  AFTER INSERT OR UPDATE ON returns
  FOR EACH ROW EXECUTE FUNCTION trg_fn_returns_health();

-- 15.6  recovery_plans → health  (FIX-2: TG_OP-safe for DELETE)
CREATE OR REPLACE FUNCTION trg_fn_recovery_health() RETURNS TRIGGER AS $$
DECLARE
  v_client_id INTEGER;
BEGIN
  -- FIX-2: On DELETE, NEW is NULL — must use OLD.client_id
  IF TG_OP = 'DELETE' THEN
    v_client_id := OLD.client_id;
  ELSE
    v_client_id := NEW.client_id;
  END IF;

  PERFORM recalc_client_health(v_client_id);

  -- RETURN must match TG_OP: DELETE → OLD, otherwise → NEW
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  ELSE
    RETURN NEW;
  END IF;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_recovery_health ON recovery_plans;
CREATE TRIGGER trg_recovery_health
  AFTER INSERT OR UPDATE OR DELETE ON recovery_plans
  FOR EACH ROW EXECUTE FUNCTION trg_fn_recovery_health();

-- ════════════════════════════════════════════════════════════
-- BLOCK 16 — view_client_360 (CTEs — no Cartesian product)
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW view_client_360 AS
WITH
ticket_agg AS (
  SELECT
    client_id,
    COUNT(*) FILTER (WHERE status NOT IN ('closed','resolved'))                                AS open_tickets,
    COUNT(*) FILTER (WHERE criticality = 'critical'
                       AND status NOT IN ('closed','resolved'))                                AS critical_tickets,
    COUNT(*) FILTER (WHERE is_recurrence = TRUE
                       AND status NOT IN ('closed','resolved'))                                AS recurrence_count,
    COUNT(*) FILTER (WHERE generated_opportunity = TRUE)                                       AS opportunity_count,
    COALESCE(SUM(revenue_at_risk)
      FILTER (WHERE status NOT IN ('closed','resolved')), 0)                                   AS total_revenue_at_risk
  FROM tickets
  GROUP BY client_id
),
sla_agg AS (
  -- sla_events table not in base schema; compute overdue directly from tickets
  SELECT
    client_id,
    COUNT(*) FILTER (WHERE NOW() > sla_deadline
                       AND NOT sla_paused
                       AND status NOT IN ('closed','resolved'))                                AS sla_overdue_count
  FROM tickets
  GROUP BY client_id
),
complaint_agg AS (
  SELECT
    client_id,
    COUNT(*) FILTER (WHERE status NOT IN ('closed','cancelled'))                               AS open_complaints,
    ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::NUMERIC, 1)                  AS csat_avg_live,
    COALESCE(SUM(loss_risk) FILTER (WHERE status NOT IN ('closed','cancelled')), 0)            AS total_loss_risk
  FROM complaints
  GROUP BY client_id
),
return_agg AS (
  SELECT
    client_id,
    COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected','refund_or_credit_issued'))      AS open_returns,
    COALESCE(SUM(total_value) FILTER (WHERE status NOT IN ('closed','rejected')), 0)           AS returns_value_at_risk
  FROM returns
  GROUP BY client_id
),
rma_agg AS (
  SELECT
    t.client_id,
    COUNT(r.id) FILTER (WHERE t.status NOT IN ('closed','resolved'))                           AS open_rma
  FROM rma r
  JOIN tickets t ON t.id = r.ticket_id
  GROUP BY t.client_id
)
SELECT
  c.id, c.name, c.cnpj, c.segment, c.is_vip,
  c.health_score, c.health_status, c.csat_avg,
  c.risk_score, c.risk_level, c.last_purchase_date,
  u_am.name  AS am_name,
  u_bdm.name AS bdm_name,
  COALESCE(ta.open_tickets,          0) AS open_tickets,
  COALESCE(ta.critical_tickets,      0) AS critical_tickets,
  COALESCE(ta.recurrence_count,      0) AS recurrence_count,
  COALESCE(ta.opportunity_count,     0) AS opportunity_count,
  COALESCE(ta.total_revenue_at_risk, 0) AS total_revenue_at_risk,
  COALESCE(sa.sla_overdue_count,     0) AS sla_overdue_count,
  COALESCE(ca.open_complaints,       0) AS open_complaints,
  ca.csat_avg_live,
  COALESCE(ca.total_loss_risk,       0) AS total_loss_risk,
  COALESCE(ra.open_returns,          0) AS open_returns,
  COALESCE(ra.returns_value_at_risk, 0) AS returns_value_at_risk,
  COALESCE(rma.open_rma,             0) AS open_rma
FROM clients c
LEFT JOIN users             u_am ON u_am.id  = c.account_manager_id
LEFT JOIN users             u_bdm ON u_bdm.id = c.bdm_id
LEFT JOIN ticket_agg        ta   ON ta.client_id   = c.id
LEFT JOIN sla_agg           sa   ON sa.client_id   = c.id
LEFT JOIN complaint_agg     ca   ON ca.client_id   = c.id
LEFT JOIN return_agg        ra   ON ra.client_id   = c.id
LEFT JOIN rma_agg           rma  ON rma.client_id  = c.id;

-- ════════════════════════════════════════════════════════════
-- BLOCK 17 — view_cs_dashboard (CTEs — no Cartesian product)
-- ════════════════════════════════════════════════════════════

CREATE OR REPLACE VIEW view_cs_dashboard AS
WITH
complaint_bu AS (
  SELECT
    business_unit_id,
    COUNT(*) FILTER (WHERE status NOT IN ('closed','cancelled'))                               AS open_complaints,
    ROUND(AVG(csat_score) FILTER (WHERE csat_score IS NOT NULL)::NUMERIC, 1)                  AS csat_avg,
    COUNT(*) FILTER (WHERE severity = 'critical')                                              AS critical_complaints,
    COALESCE(SUM(loss_risk) FILTER (WHERE status NOT IN ('closed','cancelled')), 0)            AS total_loss_risk
  FROM complaints
  GROUP BY business_unit_id
),
return_bu AS (
  SELECT
    business_unit_id,
    COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected','refund_or_credit_issued'))      AS open_returns,
    COALESCE(SUM(total_value) FILTER (WHERE status NOT IN ('closed','rejected')), 0)           AS returns_value
  FROM returns
  GROUP BY business_unit_id
),
client_health_bu AS (
  SELECT
    primary_bu,
    COUNT(*) FILTER (WHERE health_status IN ('at_risk','critical'))                            AS clients_at_risk,
    COUNT(*) FILTER (WHERE health_status = 'recovered')                                        AS clients_recovered,
    ROUND(AVG(health_score)::NUMERIC, 1)                                                       AS avg_health_score
  FROM clients
  WHERE primary_bu IS NOT NULL
  GROUP BY primary_bu
)
SELECT
  bu.id   AS business_unit_id,
  bu.name AS bu_name,
  COALESCE(cb.open_complaints,     0) AS open_complaints,
  cb.csat_avg,
  COALESCE(cb.critical_complaints, 0) AS critical_complaints,
  COALESCE(cb.total_loss_risk,     0) AS total_loss_risk,
  COALESCE(rb.open_returns,        0) AS open_returns,
  COALESCE(rb.returns_value,       0) AS returns_value,
  COALESCE(ch.clients_at_risk,     0) AS clients_at_risk,
  COALESCE(ch.clients_recovered,   0) AS clients_recovered,
  ch.avg_health_score
FROM business_units bu
LEFT JOIN complaint_bu     cb ON cb.business_unit_id = bu.id
LEFT JOIN return_bu        rb ON rb.business_unit_id = bu.id
LEFT JOIN client_health_bu ch ON ch.primary_bu       = bu.id;

COMMIT;

-- ════════════════════════════════════════════════════════════
-- BLOCK 17b — RECOMMENDED: Cron jobs for time-based recalculation
--
-- recalc_client_health() uses NOW() > sla_deadline in the SLA penalty,
-- and last_purchase_date for the time-without-purchase penalty.
-- Neither of these is a DB event — they require scheduled recalculation.
--
-- CRON JOB 1 — Hourly: SLA staleness
-- Recalculates health score for clients whose tickets may have gone
-- overdue since the last trigger event (no DB write happened to fire it).
-- Schedule: every hour at :00
--
/*
  -- Using pg_cron (if installed):
  SELECT cron.schedule(
    'cs-health-sla-hourly',
    '0 * * * *',
    $$
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT DISTINCT client_id
          FROM tickets
          WHERE status NOT IN ('closed','resolved')
            AND client_id IS NOT NULL
            AND NOT sla_paused
            AND NOW() > sla_deadline - INTERVAL '1 hour'  -- approaching or past SLA
        LOOP
          PERFORM recalc_client_health(r.client_id);
        END LOOP;
      END $$;
    $$
  );

  -- Using external scheduler (Node.js/cron/Heroku Scheduler):
  -- SELECT DISTINCT client_id FROM tickets
  --   WHERE status NOT IN ('closed','resolved')
  --     AND client_id IS NOT NULL
  --     AND NOT sla_paused
  --     AND NOW() > sla_deadline - INTERVAL '1 hour'
  -- → for each client_id: SELECT recalc_client_health(:id)
*/

-- CRON JOB 2 — Weekly (Monday 06:00 BRT): last_purchase_date staleness
-- Only clients who may cross the 90-day or 180-day penalty threshold
-- in the current week need recalculation.
--
/*
  SELECT cron.schedule(
    'cs-health-purchase-weekly',
    '0 9 * * 1',   -- 06:00 BRT = 09:00 UTC on Mondays
    $$
      DO $$
      DECLARE r RECORD;
      BEGIN
        FOR r IN
          SELECT id FROM clients
          WHERE last_purchase_date IS NOT NULL
            AND last_purchase_date < CURRENT_DATE - INTERVAL '80 days'
        LOOP
          PERFORM recalc_client_health(r.id);
        END LOOP;
      END $$;
    $$
  );
*/

-- ════════════════════════════════════════════════════════════
-- BLOCK 17c — RECOMMENDED: Backend must call transition validators
--
-- validate_complaint_transition() and validate_return_transition()
-- are IMMUTABLE PostgreSQL functions. They are NOT triggered automatically
-- on status updates — the database will accept any valid ENUM value.
-- The backend MUST call these functions (or replicate their logic)
-- before executing UPDATE ... SET status = :new_status.
--
-- Pattern in Node.js/TypeScript routes (complaints):
/*
  const { rows } = await db.query(
    'SELECT validate_complaint_transition($1::complaint_status, $2::complaint_status) AS valid',
    [currentStatus, newStatus]
  );
  if (!rows[0].valid) {
    return reply.code(422).send({
      error: 'INVALID_STATUS_TRANSITION',
      message: `Transição de '${currentStatus}' para '${newStatus}' não é permitida.`,
      from_status: currentStatus,
      to_status: newStatus,
      status: 422
    });
  }
  // proceed with UPDATE
*/
--
-- Acceptance criteria: PATCH /complaints/:id/status with invalid
-- transition MUST return HTTP 422 with error INVALID_STATUS_TRANSITION.
-- Same for PATCH /returns/:id/status.
-- ════════════════════════════════════════════════════════════


-- Run manually after migration to confirm correctness.
-- Expected output noted inline.
-- ════════════════════════════════════════════════════════════

-- 18.1  ENUMs created (expect 7 rows)
/*
SELECT typname
FROM   pg_type
WHERE  typname IN (
  'complaint_severity', 'complaint_feeling', 'complaint_procedence',
  'complaint_status',   'return_status',     'return_decision',
  'health_status'
)
ORDER BY typname;
-- Expected: 7 rows
*/

-- 18.2  complaint_type_config seeded (expect 12 rows)
/*
SELECT COUNT(*) FROM complaint_type_config;
-- Expected: 12
*/

-- 18.3  clients table has new columns
/*
SELECT column_name
FROM information_schema.columns
WHERE table_name = 'clients'
  AND column_name IN (
    'health_score','health_status','csat_avg',
    'last_purchase_date','total_revenue_at_risk',
    'total_revenue_protected','recurrence_count'
  )
ORDER BY column_name;
-- Expected: 7 rows
*/

-- 18.4  Immutability: client_health_log (expect ERROR)
/*
INSERT INTO client_health_log(client_id,health_score,health_status,reason)
  VALUES (1,80,'attention','test entry');
UPDATE client_health_log SET reason = 'edited' WHERE id = (SELECT MAX(id) FROM client_health_log);
-- Expected: ERROR: client_health_log is append-only: UPDATE operation is not permitted.
*/

-- 18.5  Immutability: return_history (expect ERROR)
/*
INSERT INTO return_history(return_id, action) VALUES (1, 'test entry');
UPDATE return_history SET action = 'edited' WHERE id = (SELECT MAX(id) FROM return_history);
-- Expected: ERROR: return_history is append-only: UPDATE operation is not permitted.
*/

-- 18.6  validate_complaint_transition: valid and invalid cases
/*
SELECT validate_complaint_transition('open',     'in_progress');  -- Expected: TRUE
SELECT validate_complaint_transition('open',     'closed');       -- Expected: FALSE
SELECT validate_complaint_transition('resolved', 'open');         -- Expected: TRUE  (reopen)
SELECT validate_complaint_transition('closed',   'open');         -- Expected: FALSE (terminal)
*/

-- 18.7  validate_return_transition
/*
SELECT validate_return_transition('return_requested', 'under_review');  -- TRUE
SELECT validate_return_transition('received',         'approved');       -- FALSE
SELECT validate_return_transition('closed',           'in_transit');     -- FALSE (terminal)
*/

-- 18.8  recalc_client_health function exists
/*
SELECT proname FROM pg_proc WHERE proname = 'recalc_client_health';
-- Expected: 1 row
*/

-- 18.9  recovery_plans trigger handles DELETE (FIX-2)
-- Create a recovery plan, delete it, verify no error and health_score updated:
/*
INSERT INTO recovery_plans(client_id, action, status)
  VALUES (1, 'test plan for deletion', 'pending');
DELETE FROM recovery_plans WHERE action = 'test plan for deletion';
-- Expected: no ERROR. SELECT health_score FROM clients WHERE id=1 should reflect the recalc.
*/

-- 18.10  No Cartesian product in view_client_360
-- For a client with 5 tickets (revenue_at_risk=10000 each) and 3 complaints:
/*
SELECT total_revenue_at_risk, open_tickets, open_complaints
FROM view_client_360
WHERE id = :test_client_id;
-- Expected: total_revenue_at_risk = 50000 (not 150000 = 5×3×10000)
-- Expected: open_tickets = 5, open_complaints = 3
*/

-- 18.11  FIX-4: recovered status preserved at score >= 60
-- Manually set a client to recovered with score 72, then trigger recalc:
/*
UPDATE clients SET health_status='recovered', health_score=72 WHERE id=1;
SELECT recalc_client_health(1);
SELECT health_status FROM clients WHERE id=1;
-- Expected: 'recovered' (not 'attention' or 'healthy')
*/

-- 18.12  FIX-5: rejected return penalty is windowed
-- Insert a return rejected 200 days ago and one rejected today:
/*
INSERT INTO returns(client_id,business_unit_id,reason,quantity,status,closed_at)
  VALUES (1,'led','old rejection',1,'rejected', NOW() - INTERVAL '200 days');
-- This should NOT add 10 to penalty (outside 180-day window)

INSERT INTO returns(client_id,business_unit_id,reason,quantity,status,closed_at)
  VALUES (1,'led','recent rejection',1,'rejected', NOW() - INTERVAL '10 days');
-- This SHOULD add 10 to penalty (within 180-day window)

SELECT recalc_client_health(1);
-- Verify in client_health_log that delta reflects only 1 rejection penalty
*/

-- 18.13  FIX-A: mark_client_recovered() — new evidence-based guards
/*
-- a) Already recovered → ALREADY_RECOVERED
UPDATE clients SET health_status = 'recovered', health_score = 72 WHERE id = 1;
SELECT mark_client_recovered(1, 99, 'This should fail because already recovered.');
-- Expected: ERROR: ALREADY_RECOVERED: cliente já está com status recovered.

-- b) score < 60 → SCORE_TOO_LOW
UPDATE clients SET health_status = 'at_risk', health_score = 45 WHERE id = 1;
SELECT mark_client_recovered(1, 99, 'Score is too low for this to work.');
-- Expected: ERROR: SCORE_TOO_LOW: score atual 45 está abaixo do mínimo 60 para recovered.

-- c) score >= 60 but no evidence → NO_RECOVERY_EVIDENCE
UPDATE clients SET health_status = 'attention', health_score = 68 WHERE id = 1;
DELETE FROM client_health_log WHERE client_id = 1;
DELETE FROM recovery_plans     WHERE client_id = 1;
SELECT mark_client_recovered(1, 99, 'No past risk history, this should also fail.');
-- Expected: ERROR: NO_RECOVERY_EVIDENCE: ...

-- d) score >= 60 WITH recent at_risk log entry → succeeds
UPDATE clients SET health_status = 'attention', health_score = 68 WHERE id = 1;
INSERT INTO client_health_log(client_id, health_score, health_status, reason)
  VALUES (1, 25, 'critical', 'Was critical 30 days ago');
SELECT mark_client_recovered(
  1, 99, 'CSAT subiu para 4.2, dois pedidos fechados, cliente confirmou retomada.'
);
SELECT health_status FROM clients WHERE id = 1;
-- Expected: 'recovered'

-- e) score >= 60 WITH completed recovery_plan → succeeds (no recent log needed)
UPDATE clients SET health_status = 'attention', health_score = 68 WHERE id = 2;
DELETE FROM client_health_log WHERE client_id = 2;
INSERT INTO recovery_plans(client_id, action, status, responsible_user_id)
  VALUES (2, 'Plano concluído', 'done', 1);
SELECT mark_client_recovered(
  2, 99, 'Plano de recuperação concluído e cliente ativo novamente.'
);
SELECT health_status FROM clients WHERE id = 2;
-- Expected: 'recovered'
*/

-- 18.14  FIX-2: set_return_closed_at fires on 'rejected' (closed_at is set)
/*
-- Insert a return and reject it
INSERT INTO returns(client_id, business_unit_id, reason, quantity, status)
  VALUES (1, 'led', 'Product not as expected', 2, 'return_requested')
  RETURNING id;
-- Assume id = :ret_id

UPDATE returns
SET status = 'under_review' WHERE id = :ret_id;

UPDATE returns
SET status = 'awaiting_approval' WHERE id = :ret_id;

UPDATE returns
SET status = 'rejected' WHERE id = :ret_id;

-- Verify closed_at was set by the trigger
SELECT id, status, closed_at FROM returns WHERE id = :ret_id;
-- Expected: closed_at IS NOT NULL (set by trigger on status = 'rejected')
-- Before FIX-2: closed_at would have been NULL here.
*/

-- 18.15  NULL-safe legacy: rejected return without closed_at still penalises
/*
-- Simulate a legacy rejection (no closed_at — as if v2.0 was applied without FIX-2)
INSERT INTO returns(client_id, business_unit_id, reason, quantity, status)
  VALUES (1, 'led', 'Legacy rejection without closed_at', 1, 'rejected')
  RETURNING id;
-- Note: closed_at is NULL because this INSERT bypasses the trigger
-- (trigger fires on UPDATE, not INSERT for this column).

SELECT recalc_client_health(1);

-- The CASE in recalc_client_health handles NULL:
--   WHEN status = 'rejected' AND (closed_at IS NULL OR closed_at >= NOW() - 180d) THEN 10
-- Expected: the legacy rejection DOES add -10 (safe treatment: assume recent).
-- Verify: SELECT health_score FROM clients WHERE id = 1 should be lower by 10.
SELECT health_score FROM clients WHERE id = 1;
*/

-- End of migration 003_cs_layer_v2.1.sql
