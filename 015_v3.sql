-- ═══════════════════════════════════════════════════════════════
-- 015_v3.sql — Nextra CSO Hub v3.0
-- Troca de senha obrigatória no primeiro acesso.
-- Idempotente: pode rodar mais de uma vez sem quebrar.
-- ═══════════════════════════════════════════════════════════════

ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;

-- Todos os usuários existentes (exceto o admin principal) devem trocar a
-- senha no próximo login — elimina o risco da senha padrão compartilhada.
UPDATE users SET must_change_password = TRUE WHERE login <> 'igor';
