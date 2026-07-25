-- ═══════════════════════════════════════════════════════════════
-- 012_am_bdm_and_attachments_everywhere.sql — Nextra CSO Hub v2.1
-- 1) Cadastro do time comercial (11 AMs + 13 BDMs)
-- 2) Anexos habilitados também em pesquisas CSAT/NPS
-- 3) Coluna de espelhamento no Google Drive
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

-- 1. Time comercial. Todos entram com role 'sales'; o campo title ('AM'/'BDM')
--    é o que separa as listas nos dropdowns do sistema.
--    Senha inicial de todos: nextra@2026 (trocar em Configurações → Usuários).
INSERT INTO users (id, name, login, password_hash, role, title, is_active) VALUES
  (501, 'Brayan',           'brayan',           '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (502, 'Larissa',          'larissa',          '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (505, 'Talyson',          'talyson',          '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (506, 'Lucas Bassi',      'lucas.bassi',      '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (507, 'Ivan',             'ivan',             '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (508, 'Talita',           'talita',           '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (509, 'Patricia',         'patricia',         '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (510, 'Cintia',           'cintia',           '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (511, 'Alex',             'alex',             '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'AM',  TRUE),
  (512, 'Marcelo Ruiz',     'marcelo.ruiz',     '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (513, 'André Barros',     'andre.barros',     '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (514, 'Gabriel Padovani', 'gabriel.padovani', '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (515, 'Sidnei',           'sidnei',           '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (516, 'Allan',            'allan',            '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (517, 'Cesar',            'cesar',            '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (518, 'Gustavo Papini',   'gustavo.papini',   '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (519, 'João',             'joao',             '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (520, 'Geovane',          'geovane',          '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (521, 'Guilherme',        'guilherme',        '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (522, 'Mariana',          'mariana',          '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (523, 'Reinaldo',         'reinaldo',         '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE),
  (524, 'Vanessa',          'vanessa',          '$2b$12$jQ7g9FPw/Q2fA7NSH.fwnuhrNkmp5LmfDruuv/VwuJqN04pLNvw5W', 'sales', 'BDM', TRUE)
ON CONFLICT (login) DO UPDATE SET title=EXCLUDED.title;
-- Gabriela e Kevyn já existem na base (seed original) — só recebem o título de AM
UPDATE users SET title='AM' WHERE login IN ('gabriela','kevyn');
-- Garante que a sequence continue depois dos IDs explícitos acima
SELECT setval('users_id_seq', GREATEST((SELECT COALESCE(MAX(id),1) FROM users), 524));

-- 2. Anexos também em pesquisas CSAT/NPS (entity_type 'survey' = survey_links.id)
ALTER TABLE attachments DROP CONSTRAINT IF EXISTS attachments_entity_type_check;
ALTER TABLE attachments ADD CONSTRAINT attachments_entity_type_check
  CHECK (entity_type IN ('ticket','return','rma','complaint','survey'));

-- 3. Espelhamento opcional no Google Drive (link público do arquivo na pasta do atendimento)
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS drive_url TEXT;
