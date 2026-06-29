require('dotenv').config();
const { Client } = require('pg');
const bcrypt = require('bcryptjs');

async function seed() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Idempotent guard — skip if already seeded
    const { rows: check } = await client.query("SELECT COUNT(*) AS cnt FROM users WHERE login = 'igor'");
    if (parseInt(check[0].cnt) > 0) {
      console.log('⏭  Seed já realizado. Pulando para não sobrescrever dados.');
      return;
    }
    console.log('▶ Seeding Full Version 1.0 demo data...\n');

    const hash = (pw) => bcrypt.hash(pw, 10);
    const [igorHash, nextraHash] = await Promise.all([hash('igor@2026'), hash('nextra@2026')]);

    await client.query(`
      INSERT INTO users (id, name, email, login, password_hash, role, title, is_active) VALUES
        (1,'Igor Oliveira','igor@nextra.com.br','igor',$1,'admin','Head BU LED/PRO AV',TRUE),
        (2,'Vitória Santos','vitoria@nextra.com.br','vitoria',$2,'cso','CSO / Pós-Venda',TRUE),
        (3,'Leonardo Costa','leonardo@nextra.com.br','leonardo',$2,'support','Suporte Técnico',TRUE),
        (4,'Ryan Souza','ryan@nextra.com.br','ryan',$2,'rma','Analista RMA',TRUE),
        (5,'André Ferreira','andre@nextra.com.br','andre',$2,'warehouse','CD / Estoque',TRUE),
        (6,'Fiscal','fiscal@nextra.com.br','fiscal',$2,'fiscal','Fiscal/Cadastro',TRUE),
        (7,'Gabriela Coelho','gabriela@nextra.com.br','gabriela',$2,'sales','Executiva Comercial',TRUE),
        (8,'Kevyn Lima','kevyn@nextra.com.br','kevyn',$2,'sales','Executivo Comercial',TRUE)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, password_hash=EXCLUDED.password_hash, role=EXCLUDED.role
    `, [igorHash, nextraHash]);
    await client.query(`SELECT setval('users_id_seq', 20, false)`);
    console.log('  ✓ Users seeded');

    await client.query(`
      INSERT INTO clients (id, name, cnpj, city, state, segment, is_vip, primary_bu, account_manager_id, health_status, health_score, csat_avg) VALUES
        (1,'CRIALED Integrações','12.345.678/0001-90','São Paulo','SP','integrador',TRUE,'led',7,'at_risk',58,3.2),
        (2,'LEDCOLOR Soluções','23.456.789/0001-01','Rio de Janeiro','RJ','integrador',FALSE,'led',8,'critical',29,2.1),
        (3,'DUOVISION Sistemas','34.567.890/0001-12','Curitiba','PR','integrador',TRUE,'led',7,'healthy',91,4.8),
        (4,'SEVEN Events','45.678.901/0001-23','Belo Horizonte','MG','eventos',FALSE,'led',8,'attention',67,3.7),
        (5,'Igreja Renascer SP','56.789.012/0001-34','São Paulo','SP','religioso',FALSE,'led',7,'attention',71,3.9),
        (6,'Academia Smart Fit','67.890.123/0001-45','São Paulo','SP','academia',FALSE,'led',8,'healthy',88,4.5),
        (7,'SEAL Indoor','78.901.234/0001-56','Florianópolis','SC','integrador',FALSE,'led',7,'recovered',76,4.2),
        (8,'VISION TECH Pro','89.012.345/0001-67','Brasília','DF','av_corporativo',TRUE,'led',8,'critical',24,1.8)
      ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, health_status=EXCLUDED.health_status,
        health_score=EXCLUDED.health_score, csat_avg=EXCLUDED.csat_avg, account_manager_id=EXCLUDED.account_manager_id
    `);
    await client.query(`SELECT setval('clients_id_seq', 20, false)`);
    console.log('  ✓ Clients seeded (8 — healthy/attention/at_risk/critical/recovered)');

    await client.query(`
      INSERT INTO tickets (id, business_unit_id, client_id, client_name, created_by_user_id, channel,
        occurrence_type, criticality, area_responsible, description, status, sla_state, sla_deadline, revenue_at_risk, is_vip, approval_status, reopen_count) VALUES
        ('CSO-0001','led',1,'CRIALED Integrações',3,'whatsapp','technical_support','high','support','Painel P3 sem sinal após atualização de firmware do receiver MRV300.','in_triage','warn',NOW()+INTERVAL '4h',25000,TRUE,'pending',0),
        ('CSO-0002','led',2,'LEDCOLOR Soluções',2,'email','quality_issue','critical','cso','Lote inteiro com pixel cluster morto — 40 módulos comprometidos.','in_resolution','overdue',NOW()-INTERVAL '2h',60000,FALSE,'pending',0),
        ('CSO-0003','led',3,'DUOVISION Sistemas',3,'whatsapp','delivery_issue','medium','warehouse','NF com valor divergente — trava fiscal.','closed','done',NOW()+INTERVAL '24h',0,FALSE,'approved',0),
        ('CSO-0004','led',4,'SEVEN Events',3,'phone','technical_support','high','support','Controladora Nova Star desligando durante evento ao vivo.','new','ok',NOW()+INTERVAL '8h',35000,FALSE,'pending',0),
        ('CSO-0005','led',5,'Igreja Renascer SP',7,'whatsapp','delivery_issue','medium','purchasing','Prazo estourado 12 dias. Obra parada.','awaiting_supplier','warn',NOW()+INTERVAL '2h',22000,FALSE,'pending',0),
        ('CSO-0006','led',8,'VISION TECH Pro',2,'email','quality_issue','critical','support','Sistema inoperante. Cliente VIP SLA nível 1. Risco de rescisão.','in_technical_analysis','overdue',NOW()-INTERVAL '6h',200000,TRUE,'pending',2),
        ('CSO-0007','led',2,'LEDCOLOR Soluções',4,'whatsapp','rma','high','rma','Troca de módulos com defeito de fabricação. 15 unidades.','awaiting_info','warn',NOW()+INTERVAL '3h',40000,FALSE,'pending',0),
        ('CSO-0008','led',7,'SEAL Indoor',3,'email','technical_support','low','support','Configuração de brilho automático.','awaiting_client_validation','ok',NOW()+INTERVAL '48h',0,FALSE,'approved',0),
        ('CSO-0009','led',1,'CRIALED Integrações',4,'email','rma','low','rma','RMA de módulo danificado no transporte.','closed','done',NOW()+INTERVAL '72h',0,FALSE,'approved',0),
        ('CSO-0010','led',8,'VISION TECH Pro',2,'whatsapp','technical_support','critical','support','Problema reincidente após reparo. Terceira ocorrência.','reopened','overdue',NOW()-INTERVAL '12h',80000,TRUE,'pending',3)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, sla_state=EXCLUDED.sla_state, revenue_at_risk=EXCLUDED.revenue_at_risk
    `);
    console.log('  ✓ Tickets seeded (10)');

    await client.query(`
      INSERT INTO ticket_history (ticket_id, user_id, action, note) VALUES
        ('CSO-0001',7,'ticket_aberto','Chamado aberto via WhatsApp — integrador com obra parada.'),
        ('CSO-0001',2,'status: new → in_triage','Triagem iniciada.'),
        ('CSO-0002',7,'ticket_aberto','Qualidade grave — lote inteiro comprometido.'),
        ('CSO-0002',2,'status: new → in_triage',NULL),
        ('CSO-0002',3,'status: in_triage → in_technical_analysis','Análise técnica iniciada.'),
        ('CSO-0002',3,'status: in_technical_analysis → in_resolution','Solução em andamento.'),
        ('CSO-0003',6,'status: in_triage → resolved','NF corrigida e reemitida.'),
        ('CSO-0003',1,'ticket_approved','Chancela aplicada.'),
        ('CSO-0003',2,'status: resolved → closed','Encerrado.'),
        ('CSO-0006',2,'nota_interna','Escalado para Igor. Risco de perda de contrato R$ 200k.'),
        ('CSO-0010',3,'status: closed → reopened','Problema recorrente. Reabrindo.'),
        ('CSO-0010',2,'nota_interna','Terceira ocorrência. Possível defeito de fabricação em lote.')
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO complaints (id, client_id, business_unit_id, type_key, severity, status, client_feeling, procedence, reason, responsible_area, loss_risk, created_by, ticket_id, created_at) VALUES
        (1,2,'led','quality','critical','in_progress','very_upset','valid','Terceiro lote consecutivo com defeito de pixel.','cso',120000,2,'CSO-0002',NOW()-INTERVAL '4 days'),
        (2,8,'led','delayed_delivery','critical','open','very_upset','valid','Prazo descumprido 15 dias. Cliente considerando rescisão.','operations',200000,2,NULL,NOW()-INTERVAL '6 days'),
        (3,1,'led','technical_support','medium','awaiting_client','neutral','partially_valid','Suporte técnico lento. Integrador perdeu confiança.','support',25000,2,'CSO-0001',NOW()-INTERVAL '2 days'),
        (4,5,'led','delayed_delivery','medium','open','upset','valid','Entrega atrasada prejudicou evento.','warehouse',15000,7,NULL,NOW()-INTERVAL '1 day'),
        (5,8,'led','quality','critical','open','very_upset','valid','Falha em painel com apenas 3 meses.','cso',90000,2,NULL,NOW()-INTERVAL '1 day'),
        (6,3,'led','commercial','low','closed','neutral','invalid','Reclamação sobre prazo — pedido feito pelo cliente com atraso.','sales',0,7,NULL,NOW()-INTERVAL '10 days')
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status
    `);
    await client.query(`SELECT setval('complaints_id_seq', 20, false)`);
    console.log('  ✓ Complaints seeded (6)');

    await client.query(`
      INSERT INTO complaint_history (complaint_id, user_id, action, note) VALUES
        (1,2,'reclamação_aberta',NULL),
        (1,2,'status: open → in_progress','Análise iniciada.'),
        (6,7,'status: open → closed','Improcedente — prazo correto.')
      ON CONFLICT DO NOTHING
    `);

    await client.query(`
      INSERT INTO returns (id, client_id, business_unit_id, reason, quantity, product_name_snap, unit_value, order_number, status, responsible_user_id, created_at) VALUES
        (1,2,'led','Módulos com defeito de fábrica',12,'Módulo LED P3 Indoor',4000,'PED-2847','under_review',4,NOW()-INTERVAL '3 days'),
        (2,8,'led','Produto entregue diferente do especificado',1,'Painel LED Outdoor P5',85000,'PED-2831','awaiting_approval',4,NOW()-INTERVAL '5 days'),
        (3,1,'led','Dano no transporte',2,'Gabinete 960x960',4600,'PED-2855','received',5,NOW()-INTERVAL '1 day'),
        (4,5,'led','Cancelamento parcial',4,'Módulo LED P4 Outdoor',4000,'PED-2861','return_requested',4,NOW()-INTERVAL '2h'),
        (5,4,'led','Falha elétrica comprovada',1,'Fonte de Alimentação',1800,'PED-2820','closed',4,NOW()-INTERVAL '10 days'),
        (6,2,'led','Tentativa fora de garantia',3,'Módulo LED P2.5',7000,'PED-2790','rejected',4,NOW()-INTERVAL '15 days')
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status
    `);
    await client.query(`UPDATE returns SET decision = 'replacement', closed_at = NOW()-INTERVAL '5 days' WHERE id = 5`);
    await client.query(`UPDATE returns SET reject_reason = 'Material fora do prazo de garantia', closed_at = NOW()-INTERVAL '10 days' WHERE id = 6`);
    await client.query(`SELECT setval('returns_id_seq', 20, false)`);

    await client.query(`
      INSERT INTO return_history (return_id, user_id, action, old_status, new_status) VALUES
        (1,4,'return_created',NULL,'return_requested'),
        (1,4,'status: return_requested → under_review','return_requested','under_review'),
        (2,4,'return_created',NULL,'return_requested'),
        (2,4,'status: return_requested → under_review','return_requested','under_review'),
        (2,4,'status: under_review → awaiting_approval','under_review','awaiting_approval')
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ Returns seeded (6)');

    await client.query(`
      INSERT INTO rma (id, client_id, business_unit_id, ticket_id, product_name, serial_number, defect_description, warranty, status, responsible_user_id, created_by_user_id, created_at) VALUES
        (1,2,'led','CSO-0007','Módulo LED P3','SN-MRV-2847','Display apagando aleatoriamente',TRUE,'technical_analysis',3,3,NOW()-INTERVAL '2 days'),
        (2,8,'led','CSO-0006','Controladora Nova Star','SN-NS-1029','Não inicializa após firmware 3.2',TRUE,'received',3,3,NOW()-INTERVAL '3 days'),
        (3,4,'led',NULL,'Receiver MRV300','SN-MRV-9981','Superaquecimento',FALSE,'awaiting_decision',3,3,NOW()-INTERVAL '4 days'),
        (4,8,'led','CSO-0010','Fonte de Alimentação',NULL,'Queimou sem carga',TRUE,'replacement',4,4,NOW()-INTERVAL '6 days'),
        (5,1,'led','CSO-0009','Módulo LED P3','SN-P3-4471','Pixel morto cluster',TRUE,'closed',3,3,NOW()-INTERVAL '13 days')
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status
    `);
    await client.query(`UPDATE rma SET rma_decision_v1 = 'replacement', closed_at = NOW()-INTERVAL '5 days', received_at = NOW()-INTERVAL '10 days' WHERE id = 5`);
    await client.query(`SELECT setval('rma_id_seq', 20, false)`);

    await client.query(`
      INSERT INTO rma_history (rma_id, user_id, action, old_status, new_status) VALUES
        (1,4,'rma_created',NULL,'requested'),(1,3,'status: requested → under_analysis','requested','under_analysis'),
        (1,3,'status: under_analysis → awaiting_shipment','under_analysis','awaiting_shipment'),
        (1,5,'status: awaiting_shipment → in_transit','awaiting_shipment','in_transit'),
        (1,5,'status: in_transit → received','in_transit','received'),
        (1,3,'status: received → technical_analysis','received','technical_analysis'),
        (5,4,'rma_created',NULL,'requested'),(5,3,'status → under_analysis','requested','under_analysis'),
        (5,3,'status → technical_analysis','under_analysis','technical_analysis'),
        (5,3,'status → awaiting_decision','technical_analysis','awaiting_decision'),
        (5,1,'status → replacement','awaiting_decision','replacement'),
        (5,3,'status → closed','replacement','closed')
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ RMAs seeded (5)');

    await client.query(`
      INSERT INTO csat (client_id, business_unit_id, score, comment, ticket_id, collected_by, collection_date) VALUES
        (1,'led',3,'Atendimento razoável mas resolveu.','CSO-0009',2,'2026-06-22'),
        (3,'led',5,'Excelente! Resolvido rapidamente.','CSO-0003',7,'2026-06-25'),
        (7,'led',4,'Boa resolução.','CSO-0008',2,'2026-06-27'),
        (2,'led',2,'Muito lento.','CSO-0007',8,'2026-06-27'),
        (6,'led',5,'Perfeito.',NULL,8,'2026-06-26'),
        (8,'led',1,'INACEITÁVEL.','CSO-0006',2,'2026-06-28')
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ CSAT seeded (6)');

    await client.query(`
      INSERT INTO nps (client_id, business_unit_id, score, comment, collected_by, collection_date) VALUES
        (3,'led',9,'Muito satisfeito com a parceria.',7,'2026-06-01'),
        (6,'led',10,'Suporte impecável.',8,'2026-06-01'),
        (7,'led',8,'Bom, melhorar prazos.',7,'2026-06-01'),
        (1,'led',6,'SLA precisa melhorar.',7,'2026-06-01'),
        (5,'led',7,'OK no geral.',7,'2026-06-01'),
        (4,'led',5,'Atrasos constantes.',8,'2026-06-01'),
        (2,'led',3,'Problemas de qualidade recorrentes.',8,'2026-06-01'),
        (8,'led',1,'Considerando mudar de fornecedor.',8,'2026-06-01')
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ NPS seeded (8)');

    await client.query(`
      INSERT INTO recovery_plans (id, client_id, business_unit_id, status, action, reason, responsible_user_id, expected_result, target_health_score, health_score_at_open, next_review_date, created_by_user_id) VALUES
        (1,2,'led','in_progress','Substituição de lote + auditoria de qualidade + follow-up semanal','Reclamações críticas recorrentes + CSAT 2.1 + risco de churn',2,'Elevar CSAT >= 3.5 e health >= 65',65,29,'2026-07-05',1),
        (2,8,'led','open','Visita técnica urgente + substituição de equipamentos + SLA 4h','Sistema crítico inoperante + risco de perda de contrato R$ 200k',1,'Resolver ocorrência, elevar health >= 60',60,24,'2026-07-01',1),
        (3,4,'led','awaiting_client','Priorização de pedidos + notificação antecipada + compensação comercial','Atraso recorrente em entregas',7,'Eliminar atrasos, elevar health >= 80',80,67,'2026-07-10',1)
      ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status
    `);
    await client.query(`SELECT setval('recovery_plans_id_seq', 10, false)`);

    await client.query(`
      INSERT INTO recovery_actions (recovery_plan_id, description, responsible, due_date, status, sort_order) VALUES
        (1,'Reunião executiva com cliente','Igor Oliveira','2026-07-02','done',0),
        (1,'Troca imediata do lote com defeito','Ryan Souza','2026-07-03','in_progress',1),
        (1,'Auditoria de processo produtivo','Vitória Santos','2026-07-08','pending',2),
        (1,'Follow-up semanal 30 dias','Gabriela Coelho','2026-08-01','pending',3),
        (2,'Visita técnica urgente','Leonardo Costa','2026-07-01','pending',0),
        (2,'Substituição equipamentos críticos','Ryan Souza','2026-07-02','pending',1),
        (2,'SLA 4h durante recuperação','Vitória Santos','2026-07-31','pending',2),
        (3,'Priorização pedidos futuros','André Ferreira','2026-07-05','pending',0),
        (3,'Notificação antecipada T-7','Gabriela Coelho','2026-07-10','pending',1)
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ Recovery Plans seeded (3 plans with actions)');

    await client.query(`
      INSERT INTO client_health_log (client_id, health_score, health_status, reason) VALUES
        (1,82,'healthy','Score inicial'),(1,71,'attention','Chamados abertos + atraso'),
        (1,65,'attention','Reclamação procedente'),(1,58,'at_risk','SLA vencido'),
        (2,75,'healthy','Score inicial'),(2,55,'attention','Primeiro lote com defeito'),
        (2,40,'at_risk','Segundo lote + CSAT 2.5'),(2,29,'critical','Terceiro lote + risco de churn'),
        (7,45,'at_risk','Múltiplos chamados'),(7,62,'attention','Plano de recuperação iniciado'),
        (7,76,'recovered','Plano concluído — meta atingida'),
        (8,71,'healthy','Score inicial'),(8,50,'attention','Sistema instável'),
        (8,35,'at_risk','SLA vencido + chamado crítico'),(8,24,'critical','Recorrência + CSAT 1.8')
      ON CONFLICT DO NOTHING
    `);
    console.log('  ✓ Health logs seeded');

    const counts = await Promise.all([
      client.query('SELECT COUNT(*) FROM users'),
      client.query('SELECT COUNT(*) FROM clients'),
      client.query('SELECT COUNT(*) FROM tickets'),
      client.query('SELECT COUNT(*) FROM complaints'),
      client.query('SELECT COUNT(*) FROM returns'),
      client.query('SELECT COUNT(*) FROM rma'),
      client.query('SELECT COUNT(*) FROM csat'),
      client.query('SELECT COUNT(*) FROM nps'),
      client.query('SELECT COUNT(*) FROM recovery_plans'),
    ]);
    console.log('\n✅ Full Version 1.0 Seed Complete:');
    ['Users','Clients','Tickets','Complaints','Returns','RMAs','CSAT','NPS','Recovery Plans']
      .forEach((n,i) => console.log(`   ${n}: ${counts[i].rows[0].count}`));
    console.log('\nCredentials: igor/igor@2026 (admin) · others/nextra@2026\n');
    console.log('⚠️  Change all passwords before production.\n');
  } catch (err) {
    console.error('✗ Seed failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}
seed();
