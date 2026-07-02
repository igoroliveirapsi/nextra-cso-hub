-- ============================================================
-- 009_report_views.sql
-- Nextra CSO Hub — Migration
-- ============================================================
-- Três views são consultadas por server.js (rotas de relatório
-- dedicadas e o endpoint agregado /dashboard/reports) mas nunca
-- foram criadas no banco: view_returns_savings, view_rma_financial
-- e view_rma_recurrence. Até agora essas seções de relatório
-- sempre voltavam vazias silenciosamente (protegidas por
-- try/catch), sem ninguém perceber porque nunca houve dado real
-- suficiente para notar a ausência.
--
-- 100% aditiva e idempotente (CREATE OR REPLACE VIEW é seguro
-- de rodar quantas vezes for preciso).
-- ============================================================

-- Economia/custo gerado por devoluções — cruza se a causa raiz foi
-- mapeada e se há ação de redução viável, separando o que já foi
-- (ou pode ser) evitado do que foi custo absorvido de fato.
CREATE OR REPLACE VIEW view_returns_savings AS
SELECT
  business_unit_id,
  COUNT(*)::int AS total_returns,
  COUNT(*) FILTER (WHERE reduction_feasible)::int AS returns_with_reduction_action,
  COALESCE(SUM(tax_cost + freight_cost + refaturamento_cost + difal_cost + warehouse_overhead_cost)
    FILTER (WHERE NOT reduction_feasible), 0) AS total_cost_absorbed,
  COALESCE(SUM(tax_cost + freight_cost + refaturamento_cost + difal_cost + warehouse_overhead_cost)
    FILTER (WHERE reduction_feasible), 0) AS total_cost_reduction_target,
  COALESCE(SUM(tax_cost + freight_cost + refaturamento_cost + difal_cost + warehouse_overhead_cost), 0) AS total_cost_generated
FROM returns
GROUP BY business_unit_id;

-- Financeiro de RMA — perda vs troca vs rebate vs devolução ao
-- cliente, com custo unitário total e rebate já efetivamente
-- recuperado por tipo de desfecho.
CREATE OR REPLACE VIEW view_rma_financial AS
SELECT
  business_unit_id,
  outcome_type,
  COUNT(*)::int AS count,
  COALESCE(SUM(unit_cost), 0) AS total_unit_cost,
  COALESCE(SUM(rebate_value) FILTER (WHERE rebate_status = 'applied'), 0) AS total_rebate_recovered
FROM rma
WHERE outcome_type IS NOT NULL
GROUP BY business_unit_id, outcome_type;

-- Produtos com reincidência de RMA (2+ ocorrências), com o
-- fornecedor associado — base para a Torre de Controle e para o
-- relatório de produtos críticos.
CREATE OR REPLACE VIEW view_rma_recurrence AS
SELECT
  COALESCE(rma.product_code, rma.product_name) AS product_key,
  rma.product_name,
  rma.product_code,
  rma.supplier_id,
  sp.name AS supplier_name,
  COUNT(*)::int AS count
FROM rma
LEFT JOIN suppliers sp ON sp.id = rma.supplier_id
GROUP BY COALESCE(rma.product_code, rma.product_name), rma.product_name, rma.product_code, rma.supplier_id, sp.name
HAVING COUNT(*) > 1
ORDER BY count DESC;

-- ============================================================
-- Fim da migration 009.
-- ============================================================
