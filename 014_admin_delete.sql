-- ═══════════════════════════════════════════════════════════════
-- 014_admin_delete.sql — Nextra CSO Hub v2.3
-- Exclusão de registros por administrador.
--
-- As tabelas de histórico são append-only por design (auditoria) e
-- bloqueiam DELETE via trigger. Esta migration ensina as duas funções
-- de proteção a reconhecer uma exclusão administrativa legítima:
-- o backend abre transação, executa SET LOCAL app.admin_delete='on'
-- e só então o CASCADE do registro-pai é aceito. Fora desse contexto,
-- o histórico continua imutável — inclusive para o próprio admin.
-- O audit_log permanece 100% imutável em qualquer cenário.
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION prevent_modification() RETURNS TRIGGER AS $$
BEGIN
  -- audit_log nunca pode ser alterado, nem em exclusão administrativa
  IF TG_TABLE_NAME <> 'audit_log'
     AND TG_OP = 'DELETE'
     AND current_setting('app.admin_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION '% is append-only. Operation % is not allowed.', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_append_only_modification() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.admin_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Table % is append-only (no % allowed)', TG_TABLE_NAME, TG_OP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_complaint_history_mod() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.admin_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'complaint_history is append-only';
END; $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION prevent_rma_history_mod() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('app.admin_delete', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'rma_history is append-only';
END; $$ LANGUAGE plpgsql;
