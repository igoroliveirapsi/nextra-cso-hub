-- ============================================================
-- NEXTRA CSO HUB — Schema v1.1
-- PostgreSQL 16+
-- Run via: npm run db:migrate
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pg_trgm";
CREATE EXTENSION IF NOT EXISTS "unaccent";

-- ── ENUMs (snake_case english in DB/API, PT labels only in frontend) ──

CREATE TYPE user_role AS ENUM (
  'admin','board','cso','operations','rma','support',
  'sales','purchasing','warehouse','fiscal'
);
CREATE TYPE criticality_level AS ENUM ('critical','high','medium','low');
CREATE TYPE ticket_status AS ENUM (
  'new','in_triage','awaiting_info','in_technical_analysis',
  'awaiting_cd_ops','awaiting_supplier','awaiting_fiscal',
  'in_resolution','awaiting_client_validation','resolved','closed','reopened'
);
CREATE TYPE approval_status_val AS ENUM ('pending','approved','rejected');
CREATE TYPE channel_type       AS ENUM ('whatsapp','email','phone','sales','portal','in_person');
CREATE TYPE application_type   AS ENUM ('indoor','outdoor','both','na');
CREATE TYPE rma_procedence     AS ENUM ('valid','invalid','needs_physical','needs_supplier','in_analysis');
CREATE TYPE rma_decision       AS ENUM (
  'immediate_swap','send_for_analysis','repair','supplier_action',
  'technical_rejection','part_replacement','remote_support','commercial_credit'
);
CREATE TYPE root_cause_category AS ENUM (
  'commercial_error','spec_error','registration_error','fiscal_error',
  'picking_error','shipping_error','transport_damage','manufacturing_defect',
  'misuse','incorrect_installation','supplier_failure','communication_failure',
  'out_of_stock','no_process','process_not_followed','training_gap',
  'incomplete_client_info','other'
);
CREATE TYPE sla_state  AS ENUM ('ok','warn','overdue','done','paused');
CREATE TYPE sla_type   AS ENUM ('first_response','triage','resolution','client_update');
CREATE TYPE risk_level AS ENUM ('healthy','attention','high_risk','executive_action');

-- ── Ticket protocol via sequence ──────────────────────────────
CREATE SEQUENCE IF NOT EXISTS ticket_seq START 1 INCREMENT 1 NO CYCLE;

CREATE OR REPLACE FUNCTION generate_ticket_id() RETURNS VARCHAR(30) AS $$
DECLARE
  today_str VARCHAR := TO_CHAR(NOW() AT TIME ZONE 'America/Sao_Paulo', 'YYYYMMDD');
  seq_val   BIGINT  := nextval('ticket_seq');
BEGIN
  RETURN 'CSO-' || today_str || '-' || LPAD(seq_val::TEXT, 4, '0');
END;
$$ LANGUAGE plpgsql;

-- ── shared updated_at trigger function ───────────────────────
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = NOW(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

-- ── Tables ────────────────────────────────────────────────────

CREATE TABLE users (
  id            SERIAL PRIMARY KEY,
  name          VARCHAR(255) NOT NULL,
  email         VARCHAR(255) UNIQUE,
  login         VARCHAR(100) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,       -- bcrypt cost >= 12, NEVER plain text
  role          user_role NOT NULL,
  title         VARCHAR(255),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_users_login  ON users(login);
CREATE INDEX idx_users_role   ON users(role);
CREATE TRIGGER trg_users_upd  BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE business_units (
  id         VARCHAR(10) PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  color_hex  VARCHAR(7) NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE occurrence_type_config (
  id           SERIAL PRIMARY KEY,
  type_key     VARCHAR(100) NOT NULL UNIQUE,
  label_pt     VARCHAR(255) NOT NULL,
  default_area user_role NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE suppliers (
  id         SERIAL PRIMARY KEY,
  name       VARCHAR(255) NOT NULL,
  cnpj       VARCHAR(18),
  contact    VARCHAR(255),
  phone      VARCHAR(50),
  email      VARCHAR(255),
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_suppliers_upd BEFORE UPDATE ON suppliers FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE clients (
  id                 SERIAL PRIMARY KEY,
  name               VARCHAR(255) NOT NULL,
  cnpj               VARCHAR(18) UNIQUE,
  city               VARCHAR(100),
  state              VARCHAR(2),
  segment            VARCHAR(100),
  is_vip             BOOLEAN NOT NULL DEFAULT FALSE,
  primary_bu         VARCHAR(10) REFERENCES business_units(id),
  account_manager_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bdm_id             INTEGER REFERENCES users(id) ON DELETE SET NULL,
  risk_score         INTEGER NOT NULL DEFAULT 0,
  risk_level         risk_level NOT NULL DEFAULT 'healthy',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_clients_cnpj       ON clients(cnpj);
CREATE INDEX idx_clients_risk_score ON clients(risk_score DESC);
CREATE INDEX idx_clients_vip        ON clients(is_vip) WHERE is_vip = TRUE;
CREATE TRIGGER trg_clients_upd BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_catalog (
  id               SERIAL PRIMARY KEY,
  name             VARCHAR(255) NOT NULL,
  code             VARCHAR(100) UNIQUE,
  model            VARCHAR(100),
  category         VARCHAR(100),
  business_unit_id VARCHAR(10) REFERENCES business_units(id),
  supplier_id      INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  warranty_months  INTEGER NOT NULL DEFAULT 12,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_catalog_code ON product_catalog(code);
CREATE TRIGGER trg_catalog_upd BEFORE UPDATE ON product_catalog FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE product_lots (
  id              SERIAL PRIMARY KEY,
  catalog_id      INTEGER NOT NULL REFERENCES product_catalog(id),
  lot_number      VARCHAR(100) NOT NULL,
  supplier_id     INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  production_date DATE,
  received_date   DATE,
  quantity        INTEGER,
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (catalog_id, lot_number)
);

CREATE TABLE product_items (
  id            SERIAL PRIMARY KEY,
  catalog_id    INTEGER NOT NULL REFERENCES product_catalog(id),
  lot_id        INTEGER REFERENCES product_lots(id) ON DELETE SET NULL,
  serial_number VARCHAR(100) UNIQUE,
  status        VARCHAR(50) NOT NULL DEFAULT 'active',
  notes         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_items_sn ON product_items(serial_number);

CREATE TABLE sla_config (
  id               SERIAL PRIMARY KEY,
  criticality      criticality_level NOT NULL,
  business_unit_id VARCHAR(10) REFERENCES business_units(id) ON DELETE CASCADE,
  -- NULL = global fallback
  first_response_h INTEGER NOT NULL,
  triage_h         INTEGER NOT NULL,
  resolution_h     INTEGER NOT NULL,
  warn_threshold_h INTEGER NOT NULL DEFAULT 8,
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (criticality, business_unit_id)
);

CREATE TABLE business_hours (
  id               SERIAL PRIMARY KEY,
  business_unit_id VARCHAR(10) REFERENCES business_units(id) ON DELETE CASCADE,
  -- NULL = global default for all BUs without specific config
  day_of_week      SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
  -- 0=Sunday, 1=Monday, ..., 6=Saturday
  start_time       TIME NOT NULL DEFAULT '08:00',
  end_time         TIME NOT NULL DEFAULT '18:00',
  is_active        BOOLEAN NOT NULL DEFAULT TRUE,
  UNIQUE (business_unit_id, day_of_week)
);

CREATE TABLE holidays (
  id               SERIAL PRIMARY KEY,
  business_unit_id VARCHAR(10) REFERENCES business_units(id) ON DELETE CASCADE,
  -- NULL = applies to all BUs
  date             DATE NOT NULL,
  name             VARCHAR(255) NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (business_unit_id, date)
);

CREATE TABLE tickets (
  id  VARCHAR(30) PRIMARY KEY DEFAULT generate_ticket_id(),

  -- Relations
  client_id           INTEGER REFERENCES clients(id) ON DELETE RESTRICT,
  business_unit_id    VARCHAR(10) NOT NULL REFERENCES business_units(id),
  am_user_id          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  bdm_user_id         INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resp_user_id        INTEGER REFERENCES users(id) ON DELETE SET NULL,
  manager_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_by_user_id  INTEGER NOT NULL REFERENCES users(id),

  -- Client snapshot (denormalized for history integrity)
  client_name    VARCHAR(255) NOT NULL,
  client_cnpj    VARCHAR(18),
  client_contact VARCHAR(255),
  client_phone   VARCHAR(100),
  client_city_uf VARCHAR(100),
  segment        VARCHAR(100),

  -- Commercial data
  channel              channel_type,
  order_number         VARCHAR(100),
  nf_number            VARCHAR(100),
  order_value          NUMERIC(15,2),
  revenue_at_risk      NUMERIC(15,2),
  sale_date            DATE,
  project_name         VARCHAR(255),
  repurchase_expected  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Product (FK + snapshot for history integrity)
  product_catalog_id  INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL,
  product_item_id     INTEGER REFERENCES product_items(id) ON DELETE SET NULL,
  product_lot_id      INTEGER REFERENCES product_lots(id) ON DELETE SET NULL,
  product_name_snap   VARCHAR(255),
  product_code_snap   VARCHAR(100),
  serial_number_snap  VARCHAR(100),
  lot_number_snap     VARCHAR(100),
  application         application_type,
  install_location    TEXT,
  tests_performed     TEXT,

  -- Classification
  occurrence_type   VARCHAR(100) NOT NULL,
  criticality       criticality_level NOT NULL,
  area_responsible  user_role NOT NULL,
  notify_areas      user_role[],
  description       TEXT NOT NULL,
  expectation       TEXT,

  -- Flags
  is_vip               BOOLEAN NOT NULL DEFAULT FALSE,
  is_recurrence        BOOLEAN NOT NULL DEFAULT FALSE,
  generated_opportunity BOOLEAN NOT NULL DEFAULT FALSE,
  validated_by_client  BOOLEAN NOT NULL DEFAULT FALSE,

  -- Status & SLA
  status       ticket_status NOT NULL DEFAULT 'new',
  sla_deadline TIMESTAMPTZ NOT NULL,
  sla_state    sla_state NOT NULL DEFAULT 'ok',
  sla_paused   BOOLEAN NOT NULL DEFAULT FALSE,
  -- total minutes paused (maintained by application when resuming)
  total_paused_minutes INTEGER NOT NULL DEFAULT 0,

  -- Resolution
  root_cause_category    root_cause_category,
  root_cause_description TEXT,
  resolution             TEXT,
  preventive_action      TEXT,
  cost_estimate          NUMERIC(15,2),
  procedence             rma_procedence,

  -- Approval (denormalized for query performance)
  approval_status  approval_status_val NOT NULL DEFAULT 'pending',
  approval_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approval_comment TEXT,
  approval_date    TIMESTAMPTZ,

  -- Control
  reopen_count INTEGER NOT NULL DEFAULT 0,
  closed_at    TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tickets_status      ON tickets(status);
CREATE INDEX idx_tickets_criticality ON tickets(criticality);
CREATE INDEX idx_tickets_bu          ON tickets(business_unit_id);
CREATE INDEX idx_tickets_client      ON tickets(client_id);
CREATE INDEX idx_tickets_am          ON tickets(am_user_id);
CREATE INDEX idx_tickets_resp        ON tickets(resp_user_id);
CREATE INDEX idx_tickets_sla         ON tickets(sla_deadline);
CREATE INDEX idx_tickets_sla_state   ON tickets(sla_state) WHERE sla_state IN ('warn','overdue');
CREATE INDEX idx_tickets_created     ON tickets(created_at DESC);
CREATE INDEX idx_tickets_vip         ON tickets(is_vip) WHERE is_vip = TRUE;
CREATE INDEX idx_tickets_opportunity ON tickets(generated_opportunity) WHERE generated_opportunity = TRUE;
CREATE INDEX idx_tickets_area        ON tickets(area_responsible);
CREATE INDEX idx_tickets_fts ON tickets USING gin(
  to_tsvector('portuguese',
    coalesce(client_name,'') || ' ' || coalesce(id,'') || ' ' ||
    coalesce(product_name_snap,'') || ' ' || coalesce(description,'') || ' ' ||
    coalesce(order_number,'') || ' ' || coalesce(nf_number,''))
);
CREATE TRIGGER trg_tickets_upd BEFORE UPDATE ON tickets FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE ticket_history (
  id            BIGSERIAL PRIMARY KEY,
  ticket_id     VARCHAR(30) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action        VARCHAR(255) NOT NULL,
  field_changed VARCHAR(100),
  old_value     TEXT,
  new_value     TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: append-only, never modified
);
CREATE INDEX idx_th_ticket ON ticket_history(ticket_id, created_at DESC);
CREATE INDEX idx_th_user   ON ticket_history(user_id);

CREATE TABLE ticket_attachments (
  id              SERIAL PRIMARY KEY,
  ticket_id       VARCHAR(30) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  uploaded_by     INTEGER NOT NULL REFERENCES users(id),
  file_name       VARCHAR(500) NOT NULL,
  file_type       VARCHAR(50),
  mime_type       VARCHAR(100),
  file_size_bytes INTEGER,
  storage_url     TEXT NOT NULL,
  bucket_key      TEXT,
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_attach_ticket ON ticket_attachments(ticket_id);

CREATE TABLE rma (
  id                     SERIAL PRIMARY KEY,
  ticket_id              VARCHAR(30) NOT NULL UNIQUE REFERENCES tickets(id) ON DELETE CASCADE,
  product_catalog_id     INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL,
  product_item_id        INTEGER REFERENCES product_items(id) ON DELETE SET NULL,
  product_lot_id         INTEGER REFERENCES product_lots(id) ON DELETE SET NULL,
  replacement_catalog_id INTEGER REFERENCES product_catalog(id) ON DELETE SET NULL,
  supplier_id            INTEGER REFERENCES suppliers(id) ON DELETE SET NULL,
  defect_reported        TEXT,
  remote_diagnosis       TEXT,
  documentation_status   VARCHAR(50),
  send_auth_code         VARCHAR(50),
  received_date          DATE,
  analysis_date          DATE,
  technician_user_id     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  technical_report       TEXT,
  procedence             rma_procedence,
  decision               rma_decision,
  repair_cost            NUMERIC(15,2),
  supplier_status        VARCHAR(100),
  final_solution         TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_rma_ticket ON rma(ticket_id);
CREATE TRIGGER trg_rma_upd BEFORE UPDATE ON rma FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE sla_pause_events (
  id             SERIAL PRIMARY KEY,
  ticket_id      VARCHAR(30) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  sla_type       sla_type NOT NULL DEFAULT 'resolution',
  paused_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resumed_at     TIMESTAMPTZ,
  pause_reason   VARCHAR(255),
  paused_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
  resumed_by     INTEGER REFERENCES users(id) ON DELETE SET NULL,
  minutes_paused INTEGER GENERATED ALWAYS AS (
    CASE WHEN resumed_at IS NOT NULL
      THEN GREATEST(0, EXTRACT(EPOCH FROM (resumed_at - paused_at))::INTEGER / 60)
    ELSE NULL END
  ) STORED
);
CREATE INDEX idx_pause_ticket ON sla_pause_events(ticket_id, paused_at DESC);

CREATE TABLE approvals (
  id          SERIAL PRIMARY KEY,
  ticket_id   VARCHAR(30) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  user_id     INTEGER NOT NULL REFERENCES users(id),
  status      approval_status_val NOT NULL,
  comment     TEXT,
  decided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_approvals_ticket ON approvals(ticket_id, decided_at DESC);

CREATE TABLE tasks (
  id                  SERIAL PRIMARY KEY,
  ticket_id           VARCHAR(30) NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  title               VARCHAR(500) NOT NULL,
  area                user_role,
  responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  due_date            DATE,
  status              VARCHAR(50) NOT NULL DEFAULT 'pending',
  completed_at        TIMESTAMPTZ,
  created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_tasks_ticket ON tasks(ticket_id);
CREATE TRIGGER trg_tasks_upd BEFORE UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE notifications (
  id         SERIAL PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  ticket_id  VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  type       VARCHAR(100) NOT NULL,
  message    TEXT NOT NULL,
  is_read    BOOLEAN NOT NULL DEFAULT FALSE,
  read_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_notif_user ON notifications(user_id, is_read, created_at DESC);

CREATE TABLE audit_log (
  id         BIGSERIAL PRIMARY KEY,
  user_id    INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action     VARCHAR(100) NOT NULL,
  entity     VARCHAR(100),
  entity_id  VARCHAR(100),
  old_data   JSONB,
  new_data   JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  -- NO updated_at: immutable
);
CREATE INDEX idx_audit_user   ON audit_log(user_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

CREATE TABLE recovery_plans (
  id                  SERIAL PRIMARY KEY,
  client_id           INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  ticket_id           VARCHAR(30) REFERENCES tickets(id) ON DELETE SET NULL,
  responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  action              TEXT NOT NULL,
  due_date            DATE,
  status              VARCHAR(50) NOT NULL DEFAULT 'pending',
  decision_needed     TEXT,
  leadership_involved BOOLEAN NOT NULL DEFAULT FALSE,
  completed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE communication_templates (
  id         SERIAL PRIMARY KEY,
  title      VARCHAR(255) NOT NULL,
  type_key   VARCHAR(100) NOT NULL,
  content    TEXT NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Immutability triggers ─────────────────────────────────────
CREATE OR REPLACE FUNCTION prevent_modification() RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION '% is append-only. Operation % is not allowed.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_history_immutable
  BEFORE UPDATE OR DELETE ON ticket_history
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

CREATE TRIGGER trg_audit_immutable
  BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION prevent_modification();

-- ── closed_at trigger ─────────────────────────────────────────
CREATE OR REPLACE FUNCTION set_closed_at() RETURNS TRIGGER AS $$
BEGIN
  IF NEW.status = 'closed' AND OLD.status != 'closed' THEN
    NEW.closed_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_ticket_closed_at
  BEFORE UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION set_closed_at();

-- ── Risk score: corrected — no double VIP, exclude closed/resolved ──
CREATE OR REPLACE FUNCTION recalc_client_risk(p_client_id INTEGER) RETURNS VOID AS $$
DECLARE
  vip_bonus  INTEGER := 0;
  ticket_score INTEGER := 0;
  new_score  INTEGER := 0;
  new_level  risk_level;
BEGIN
  IF p_client_id IS NULL THEN RETURN; END IF;

  -- VIP bonus: applied once per client (not per ticket)
  SELECT CASE WHEN is_vip THEN 2 ELSE 0 END
  INTO vip_bonus
  FROM clients
  WHERE id = p_client_id;

  -- Score from ACTIVE tickets only (not closed/resolved)
  SELECT COALESCE(SUM(
    -- criticality (only active critical tickets count)
    CASE WHEN t.criticality = 'critical' THEN 3 ELSE 0 END +
    -- SLA overdue (only from active, non-paused tickets)
    CASE WHEN se.state = 'overdue' AND NOT t.sla_paused THEN 3 ELSE 0 END +
    -- high revenue at risk
    CASE WHEN COALESCE(t.revenue_at_risk, 0) > 50000 THEN 3 ELSE 0 END +
    -- recurrence
    CASE WHEN t.is_recurrence THEN 2 ELSE 0 END +
    -- negative NPS/CSAT
    CASE WHEN t.occurrence_type = 'nps_csat_negative' THEN 2 ELSE 0 END +
    -- open RMA
    CASE WHEN r.id IS NOT NULL THEN 1 ELSE 0 END +
    -- has been reopened
    CASE WHEN t.reopen_count > 0 THEN 1 ELSE 0 END
  ), 0)
  INTO ticket_score
  FROM tickets t
  LEFT JOIN sla_pause_events spe ON spe.ticket_id = t.id AND spe.resumed_at IS NULL
  LEFT JOIN (
    SELECT DISTINCT ON (ticket_id) ticket_id, state
    FROM (
      SELECT t2.id AS ticket_id,
        CASE
          WHEN t2.status IN ('resolved','closed') THEN 'done'::sla_state
          WHEN t2.sla_paused THEN 'paused'::sla_state
          WHEN NOW() > t2.sla_deadline THEN 'overdue'::sla_state
          WHEN t2.sla_deadline - NOW() < INTERVAL '8 hours' THEN 'warn'::sla_state
          ELSE 'ok'::sla_state
        END AS state
      FROM tickets t2
      WHERE t2.client_id = p_client_id
    ) sub
  ) se ON se.ticket_id = t.id
  LEFT JOIN rma r ON r.ticket_id = t.id
  WHERE t.client_id = p_client_id
    AND t.status NOT IN ('closed', 'resolved');  -- ONLY active tickets

  new_score := ticket_score + vip_bonus;

  new_level := CASE
    WHEN new_score <= 3  THEN 'healthy'::risk_level
    WHEN new_score <= 6  THEN 'attention'::risk_level
    WHEN new_score <= 10 THEN 'high_risk'::risk_level
    ELSE 'executive_action'::risk_level
  END;

  UPDATE clients
  SET risk_score = new_score, risk_level = new_level, updated_at = NOW()
  WHERE id = p_client_id;
END;
$$ LANGUAGE plpgsql;

-- Trigger on tickets
CREATE OR REPLACE FUNCTION trg_fn_tickets_risk() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_risk(COALESCE(NEW.client_id, OLD.client_id));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tickets_risk
  AFTER INSERT OR UPDATE ON tickets
  FOR EACH ROW EXECUTE FUNCTION trg_fn_tickets_risk();

-- Trigger on rma (open/close affects +1)
CREATE OR REPLACE FUNCTION trg_fn_rma_risk() RETURNS TRIGGER AS $$
BEGIN
  PERFORM recalc_client_risk(
    (SELECT client_id FROM tickets WHERE id = COALESCE(NEW.ticket_id, OLD.ticket_id))
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_rma_risk
  AFTER INSERT OR UPDATE ON rma
  FOR EACH ROW EXECUTE FUNCTION trg_fn_rma_risk();

-- ── View: active tickets with computed SLA state ──────────────
CREATE OR REPLACE VIEW view_tickets_active AS
SELECT
  t.*,
  u_r.name     AS resp_name,
  u_a.name     AS am_name,
  u_b.name     AS bdm_name,
  u_m.name     AS manager_name,
  u_c.name     AS created_by_name,
  bu.name      AS bu_name,
  bu.color_hex AS bu_color,
  CASE
    WHEN t.status IN ('resolved','closed') THEN 'done'::sla_state
    WHEN t.sla_paused THEN 'paused'::sla_state
    WHEN NOW() > t.sla_deadline THEN 'overdue'::sla_state
    WHEN t.sla_deadline - NOW() < INTERVAL '8 hours' THEN 'warn'::sla_state
    ELSE 'ok'::sla_state
  END AS computed_sla_state
FROM tickets t
LEFT JOIN users u_r ON u_r.id = t.resp_user_id
LEFT JOIN users u_a ON u_a.id = t.am_user_id
LEFT JOIN users u_b ON u_b.id = t.bdm_user_id
LEFT JOIN users u_m ON u_m.id = t.manager_user_id
LEFT JOIN users u_c ON u_c.id = t.created_by_user_id
JOIN  business_units bu ON bu.id = t.business_unit_id;

-- ── View: product incidents ───────────────────────────────────
CREATE OR REPLACE VIEW view_product_incidents AS
SELECT
  COALESCE(t.product_catalog_id::TEXT, t.product_name_snap) AS product_ref,
  t.product_name_snap AS product_name,
  t.product_code_snap AS product_code,
  t.business_unit_id,
  COUNT(t.id)                                                AS total_tickets,
  COUNT(t.id) FILTER (WHERE t.occurrence_type LIKE '%rma%') AS rma_count,
  COUNT(t.id) FILTER (WHERE t.is_recurrence = TRUE)         AS recurrence_count,
  COALESCE(SUM(t.cost_estimate), 0)                         AS total_cost,
  MAX(t.created_at)                                         AS last_incident_at
FROM tickets t
WHERE t.product_name_snap IS NOT NULL
GROUP BY product_ref, t.product_name_snap, t.product_code_snap, t.business_unit_id
ORDER BY total_tickets DESC;
