-- ============================================================
-- 000_limpar_dados_demo.sql
-- Nextra CSO Hub — Limpeza de dados de demonstração/teste
-- ============================================================
-- ⚠️  ATENÇÃO — OPERAÇÃO IRREVERSÍVEL ⚠️
-- Este script APAGA PERMANENTEMENTE todos os dados transacionais
-- (clientes, chamados, reclamações, devoluções, RMA, CSAT/NPS,
-- planos de recuperação e todo o histórico ligado a eles) —
-- tanto os dados de demonstração originais quanto qualquer
-- registro de teste criado manualmente durante o desenvolvimento.
--
-- NÃO é uma migration — não deve ser adicionada ao migrate.js
-- nem rodar automaticamente no deploy. É para ser executada
-- UMA VEZ, manualmente, por você, direto no banco de produção,
-- antes da Vitória começar a subir dados reais.
--
-- O QUE É PRESERVADO (não é tocado):
--   • Seu login admin (igor) — para você não ficar trancado fora
--   • Tabelas de configuração/referência: business_units,
--     business_hours, holidays, sla_config, complaint_type_config,
--     occurrence_type_config, communication_templates
--   • schema_migrations (controle de migrations já aplicadas)
--   • Estrutura do banco (tabelas, colunas, índices, triggers)
--
-- O QUE É APAGADO:
--   • Todos os clientes, chamados, reclamações, devoluções, RMA
--   • Todo CSAT/NPS, links de pesquisa, planos de recuperação
--   • Todo histórico (ticket_history, complaint_history, etc.)
--   • Todos os fornecedores cadastrados (inclusive de teste)
--   • Todos os usuários da equipe, EXCETO o login "igor"
--     (recadastre a equipe real pela tela Configurações depois)
--
-- COMO RODAR:
--   Railway → seu projeto → aba "Postgres" (o banco, não o app)
--   → aba "Data" → "Query" (ou conecte via psql usando a
--   DATABASE_URL que aparece em "Connect"). Cole este script
--   inteiro e execute de uma vez.
-- ============================================================

BEGIN;

-- Apaga clientes e tickets — o CASCADE arrasta automaticamente
-- tudo que depende deles: chamados, reclamações, devoluções, RMA,
-- CSAT, NPS, planos de recuperação, histórico de saúde, links de
-- pesquisa, anexos, aprovações, tarefas, notificações e todo o
-- histórico de cada um desses módulos.
TRUNCATE TABLE clients, tickets RESTART IDENTITY CASCADE;

-- Fornecedores (RMA) — não é filho de clients/tickets, precisa
-- de TRUNCATE separado.
TRUNCATE TABLE suppliers RESTART IDENTITY CASCADE;

-- Log de auditoria (hoje não está em uso ativo, mas limpa por via das dúvidas).
TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE;

-- Reseta a numeração de protocolo de chamados (CSO-AAAAMMDD-0001...)
-- para começar do zero de novo.
ALTER SEQUENCE ticket_seq RESTART WITH 1;

-- Remove todos os usuários de demonstração/teste, mantendo só o
-- login "igor" — recadastre a equipe real pela tela Configurações.
DELETE FROM users WHERE login <> 'igor';
SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id), 1) FROM users), true);

COMMIT;

-- ============================================================
-- Verificação — todas as contagens abaixo devem retornar 0,
-- exceto "users" que deve retornar 1 (só o seu login).
-- ============================================================
SELECT 'clients' AS tabela, COUNT(*) FROM clients
UNION ALL SELECT 'tickets', COUNT(*) FROM tickets
UNION ALL SELECT 'complaints', COUNT(*) FROM complaints
UNION ALL SELECT 'returns', COUNT(*) FROM returns
UNION ALL SELECT 'rma', COUNT(*) FROM rma
UNION ALL SELECT 'csat', COUNT(*) FROM csat
UNION ALL SELECT 'nps', COUNT(*) FROM nps
UNION ALL SELECT 'recovery_plans', COUNT(*) FROM recovery_plans
UNION ALL SELECT 'survey_links', COUNT(*) FROM survey_links
UNION ALL SELECT 'suppliers', COUNT(*) FROM suppliers
UNION ALL SELECT 'users (deve ser 1)', COUNT(*) FROM users;

-- ============================================================
-- Fim. Se todas as contagens baterem com o esperado, o banco
-- está limpo e pronto para receber dados reais.
-- ============================================================
