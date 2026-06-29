-- ============================================================
-- NEXTRA CSO HUB — Seeds v1.1
-- Reference data only.
-- Users are inserted by scripts/seed.js (bcrypt generated at runtime).
-- ============================================================

-- ── Business Units ────────────────────────────────────────────
INSERT INTO business_units(id, name, color_hex) VALUES
  ('led', 'LED / PRO AV',           '#6D40E6'),
  ('seg', 'Segurança Eletrônica',    '#2563C9'),
  ('av',  'Áudio e Vídeo',           '#13966B'),
  ('cab', 'Cabeamento Estruturado',  '#D98309')
ON CONFLICT (id) DO NOTHING;

-- ── Occurrence type routing ───────────────────────────────────
INSERT INTO occurrence_type_config(type_key, label_pt, default_area, sort_order) VALUES
  ('technical_support',     'Suporte técnico',                'support',   1),
  ('rma_defect',            'RMA / Defeito de produto',       'support',   2),
  ('warranty_request',      'Solicitação de garantia',        'support',   3),
  ('product_defect',        'Produto com defeito',            'support',   4),
  ('missing_item',          'Item faltante',                  'warehouse', 5),
  ('wrong_product',         'Produto enviado errado',         'warehouse', 6),
  ('transport_damage',      'Dano no transporte',             'warehouse', 7),
  ('picking_error',         'Erro de separação',              'warehouse', 8),
  ('spec_error',            'Erro de especificação',          'sales',     9),
  ('fiscal_discrepancy',    'Divergência fiscal',             'fiscal',    10),
  ('registration_issue',    'Problema de cadastro',           'fiscal',    11),
  ('delivery_delay',        'Atraso de entrega',              'warehouse', 12),
  ('commercial_complaint',  'Reclamação comercial',           'sales',     13),
  ('operational_complaint', 'Reclamação operacional',         'warehouse', 14),
  ('installation_config',   'Instalação / Configuração',      'support',   15),
  ('technical_question',    'Dúvida técnica',                 'support',   16),
  ('nps_csat_negative',     'NPS / CSAT negativo',            'sales',     17),
  ('exchange_return',       'Troca / Devolução',              'cso',       18),
  ('client_at_risk',        'Cliente em risco',               'sales',     19)
ON CONFLICT (type_key) DO NOTHING;

-- ── SLA config (global defaults — no BU = applies to all) ────
INSERT INTO sla_config(criticality, business_unit_id, first_response_h, triage_h, resolution_h, warn_threshold_h)
VALUES
  ('critical', NULL,  2,  8,  24,  8),
  ('high',     NULL,  4,  8,  48,  8),
  ('medium',   NULL,  8, 24,  72, 16),
  ('low',      NULL, 24, 48, 120, 24)
ON CONFLICT (criticality, business_unit_id) DO NOTHING;

-- ── Business hours: Mon–Fri 08:00–18:00 (global, NULL = all BUs) ─
INSERT INTO business_hours(business_unit_id, day_of_week, start_time, end_time) VALUES
  (NULL, 1, '08:00', '18:00'),   -- Monday
  (NULL, 2, '08:00', '18:00'),   -- Tuesday
  (NULL, 3, '08:00', '18:00'),   -- Wednesday
  (NULL, 4, '08:00', '18:00'),   -- Thursday
  (NULL, 5, '08:00', '18:00')    -- Friday
  -- Saturday (6) and Sunday (0) are NOT inserted = non-working days
ON CONFLICT (business_unit_id, day_of_week) DO NOTHING;

-- ── National holidays 2026 (Brazil) ──────────────────────────
INSERT INTO holidays(business_unit_id, date, name) VALUES
  (NULL, '2026-01-01', 'Ano Novo'),
  (NULL, '2026-02-16', 'Carnaval'),
  (NULL, '2026-02-17', 'Carnaval'),
  (NULL, '2026-04-03', 'Sexta-feira Santa'),
  (NULL, '2026-04-21', 'Tiradentes'),
  (NULL, '2026-05-01', 'Dia do Trabalho'),
  (NULL, '2026-09-07', 'Independência do Brasil'),
  (NULL, '2026-10-12', 'Nossa Senhora Aparecida'),
  (NULL, '2026-11-02', 'Finados'),
  (NULL, '2026-11-15', 'Proclamação da República'),
  (NULL, '2026-12-25', 'Natal')
ON CONFLICT (business_unit_id, date) DO NOTHING;

-- ── Communication templates ───────────────────────────────────
INSERT INTO communication_templates(title, type_key, content) VALUES
  ('Primeiro retorno',          'first_contact',       'Olá, [nome]. Recebemos sua solicitação sobre [produto/pedido] registrada como [ID]. Retornamos até [prazo].'),
  ('Solicitação de evidências',  'request_evidence',    'Olá, [nome]. Para avançar no chamado [ID] precisamos: NF, fotos/vídeo, número de série/lote, descrição do comportamento.'),
  ('Atualização de status',      'status_update',       'Atualização chamado [ID]: em [análise]. Próximo passo: [ação]. Previsão: [prazo].'),
  ('Aprovação de RMA',           'rma_approved',        'Olá, [nome]. RMA [ID] aprovado. Autorização de envio: [código]. Envie com NF de remessa para [endereço].'),
  ('Negativa de garantia',       'warranty_rejected',   'Olá, [nome]. Após análise do chamado [ID], a ocorrência não é coberta pela garantia. Motivo: [causa].'),
  ('Encerramento',               'closure',             'Olá, [nome]. Chamado [ID] encerrado com [solução]. Seguimos à disposição.'),
  ('Escalonamento interno',      'internal_escalation', 'Escalonamento — Chamado [ID] | Cliente: [cliente] | Valor: [R$] | Área: [área] | Decisão: [decisão]'),
  ('Acompanhamento VIP',         'vip_followup',        'Olá, [nome]. O Pós-Venda da Nextra acompanha seu projeto [produto]. Tudo certo? Podemos apoiar?'),
  ('Solicitação de validação',   'request_validation',  'Olá, [nome]. Solução aplicada no chamado [ID]: [solução]. Você confirma que o problema foi resolvido?'),
  ('Comunicado de atraso',       'delay_notice',        'Olá, [nome]. Identificamos atraso no chamado [ID]. Motivo: [motivo]. Nova previsão: [prazo].'),
  ('Aprovação de gestor',        'approval_request',    'Aprovação necessária — Chamado [ID] | Cliente: [cliente] | Decisão: [decisão] | Custo: [valor]')
ON CONFLICT DO NOTHING;

-- NOTE: Users are NOT in this file.
-- Run: npm run db:seed  (scripts/seed.js generates bcrypt hashes at runtime)
