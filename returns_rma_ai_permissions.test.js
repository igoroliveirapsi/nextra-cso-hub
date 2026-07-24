'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, loginAsAdmin, authHeaders } = require('./helpers');

async function createClient(app, h) {
  const res = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: h, payload: { name: 'Cliente RMA Teste ' + Date.now() + Math.random() } });
  return JSON.parse(res.body).id;
}

async function createReturnUnderInspection(app, h, clientId) {
  const createRes = await app.inject({
    method: 'POST', url: '/api/v1/returns', headers: h,
    payload: { client_id: clientId, reason: 'Motivo de teste', product_name: 'Produto Teste', quantity: 1 },
  });
  const ret = JSON.parse(createRes.body);
  const steps = ['under_review', 'awaiting_approval'];
  for (const s of steps) {
    await app.inject({ method: 'PATCH', url: `/api/v1/returns/${ret.id}/status`, headers: h, payload: { status: s } });
  }
  await app.inject({ method: 'PATCH', url: `/api/v1/returns/${ret.id}/status`, headers: h, payload: { status: 'approved', decision: 'credit' } });
  for (const s of ['awaiting_customer_shipment', 'in_transit', 'received', 'under_inspection']) {
    await app.inject({ method: 'PATCH', url: `/api/v1/returns/${ret.id}/status`, headers: h, payload: { status: s } });
  }
  return ret.id;
}

test('devolução → inspeção → RMA', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const token = await loginAsAdmin(app);
  const h = authHeaders(token);

  await t.test('inspeção aprovada (funcional) não permite abrir RMA', async () => {
    const clientId = await createClient(app, h);
    const returnId = await createReturnUnderInspection(app, h, clientId);
    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/v1/returns/${returnId}`, headers: h,
      payload: { inspection_status: 'approved_functional', inspection_report: 'Produto testado, funcionando perfeitamente.', available_for_resale: true },
    });
    assert.equal(patchRes.statusCode, 200, patchRes.body);
    const rmaRes = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(rmaRes.statusCode, 422);
    assert.equal(JSON.parse(rmaRes.body).error, 'INSPECTION_NOT_REJECTED');
  });

  await t.test('inspeção reprovada exige laudo técnico para abrir RMA', async () => {
    const clientId = await createClient(app, h);
    const returnId = await createReturnUnderInspection(app, h, clientId);
    await app.inject({ method: 'PATCH', url: `/api/v1/returns/${returnId}`, headers: h, payload: { inspection_status: 'rejected_defect' } });
    const rmaRes = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(rmaRes.statusCode, 422);
    assert.equal(JSON.parse(rmaRes.body).error, 'MISSING_REPORT');
  });

  await t.test('criação transacional do RMA a partir de devolução reprovada com laudo', async () => {
    const clientId = await createClient(app, h);
    const returnId = await createReturnUnderInspection(app, h, clientId);
    await app.inject({
      method: 'PATCH', url: `/api/v1/returns/${returnId}`, headers: h,
      payload: { inspection_status: 'rejected_defect', inspection_report: 'Defeito de fábrica confirmado em bancada.' },
    });
    const rmaRes = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(rmaRes.statusCode, 201, rmaRes.body);
    const body = JSON.parse(rmaRes.body);
    assert.ok(body.rma.id);
    assert.equal(body.rma.return_id, returnId);

    const returnAfter = await app.inject({ method: 'GET', url: `/api/v1/returns/${returnId}`, headers: h });
    const retData = JSON.parse(returnAfter.body);
    assert.equal(retData.status, 'closed', 'devolução deve encerrar somente após o RMA ser criado com sucesso');
    assert.equal(retData.linked_rma_id, body.rma.id);
  });

  await t.test('bloqueia RMA duplicado para a mesma devolução', async () => {
    const clientId = await createClient(app, h);
    const returnId = await createReturnUnderInspection(app, h, clientId);
    await app.inject({
      method: 'PATCH', url: `/api/v1/returns/${returnId}`, headers: h,
      payload: { inspection_status: 'rejected_defect', inspection_report: 'Defeito confirmado.' },
    });
    const first = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(first.statusCode, 201);
    const second = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(second.statusCode, 422, 'segunda tentativa deve ser bloqueada pois a devolução já está fechada com RMA vinculado');
  });

  await t.test('se a criação do RMA falhar, a devolução permanece aberta (sem alteração parcial)', async () => {
    const clientId = await createClient(app, h);
    const returnId = await createReturnUnderInspection(app, h, clientId);
    // Sem inspection_status='rejected_defect' e sem laudo — a criação do RMA
    // falha na validação, ANTES de qualquer escrita. A devolução deve
    // continuar exatamente como estava (under_inspection, sem RMA vinculado).
    const before = await app.inject({ method: 'GET', url: `/api/v1/returns/${returnId}`, headers: h });
    const beforeData = JSON.parse(before.body);

    const rmaRes = await app.inject({ method: 'POST', url: `/api/v1/returns/${returnId}/create-rma`, headers: h, payload: {} });
    assert.equal(rmaRes.statusCode, 422);

    const after = await app.inject({ method: 'GET', url: `/api/v1/returns/${returnId}`, headers: h });
    const afterData = JSON.parse(after.body);
    assert.equal(afterData.status, beforeData.status, 'status da devolução não deve mudar quando o RMA falha');
    assert.equal(afterData.linked_rma_id, null);
  });
});

test('IA — configurada, indisponível e resposta inválida', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const token = await loginAsAdmin(app);
  const h = authHeaders(token);

  await t.test('IA indisponível retorna 503 claro quando ANTHROPIC_API_KEY não está definida', async () => {
    assert.equal(process.env.ANTHROPIC_API_KEY, undefined, 'este teste assume ambiente sem chave configurada');
    const res = await app.inject({
      method: 'POST', url: '/api/v1/ai/triage', headers: h,
      payload: { description: 'Descrição de teste com mais de dez caracteres para IA.' },
    });
    assert.equal(res.statusCode, 503);
    assert.equal(JSON.parse(res.body).error, 'AI_UNAVAILABLE');
  });

  await t.test('GET /ai/status informa claramente que a IA não está configurada', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/ai/status', headers: h });
    assert.equal(res.statusCode, 200);
    assert.equal(JSON.parse(res.body).configured, false);
  });

  await t.test('IA configurada mas com resposta inválida (JSON quebrado) é tratada com erro claro', async () => {
    // Simula uma chave configurada e intercepta o fetch global para devolver
    // uma resposta da Anthropic com texto que não é JSON válido — sem
    // depender de rede real nem de uma chave verdadeira.
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-key-for-test';
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: 'isto não é JSON válido {{{' }] }),
    });
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/ai/triage', headers: h,
        payload: { description: 'Descrição de teste com mais de dez caracteres para IA.' },
      });
      assert.equal(res.statusCode, 502);
      assert.equal(JSON.parse(res.body).error, 'AI_INVALID_RESPONSE');
    } finally {
      global.fetch = originalFetch;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  await t.test('IA configurada com resposta válida cai para valores seguros quando o vocabulário é desconhecido', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-fake-key-for-test';
    const originalFetch = global.fetch;
    global.fetch = async () => ({
      ok: true,
      json: async () => ({ content: [{ type: 'text', text: JSON.stringify({
        occurrence_type: 'tipo_que_nao_existe', criticality: 'nivel_invalido',
        notify_areas: ['area_invalida', 'support'], root_cause_hypothesis: 'x', next_steps: 'y', client_communication: 'z',
      }) }] }),
    });
    try {
      const res = await app.inject({
        method: 'POST', url: '/api/v1/ai/triage', headers: h,
        payload: { description: 'Descrição de teste com mais de dez caracteres para IA.' },
      });
      assert.equal(res.statusCode, 200);
      const result = JSON.parse(res.body).result;
      assert.equal(result.occurrence_type, 'other', 'tipo desconhecido deve cair para "other"');
      assert.equal(result.criticality, 'medium', 'criticidade desconhecida deve cair para "medium"');
      assert.deepEqual(result.notify_areas, ['support'], 'áreas fora do vocabulário devem ser filtradas');
    } finally {
      global.fetch = originalFetch;
      delete process.env.ANTHROPIC_API_KEY;
    }
  });
});

test('permissões', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const adminToken = await loginAsAdmin(app);

  await t.test('usuário board não pode alterar status de chamado (somente leitura)', async () => {
    const h = authHeaders(adminToken);
    const createRes = await app.inject({
      method: 'POST', url: '/api/v1/tickets', headers: h,
      payload: { client_name: 'Cliente Permissão', description: 'Descrição de teste de permissão com dez chars.', nf_number: 'NF-PERM-1', quantity: 1 },
    });
    const ticket = JSON.parse(createRes.body);

    // Cria um usuário de teste com papel "board" para validar a restrição.
    const login = 'board_test_' + Date.now();
    await app.inject({
      method: 'POST', url: '/api/v1/users', headers: h,
      payload: { name: 'Board Teste', login, password: 'senha123456', role: 'board' },
    });
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: 'senha123456' } });
    const boardToken = JSON.parse(loginRes.body).token;

    const res = await app.inject({
      method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: authHeaders(boardToken),
      payload: { status: 'in_triage' },
    });
    assert.equal(res.statusCode, 403);
  });

  await t.test('apenas admin pode listar/criar usuários', async () => {
    const login = 'nao_admin_' + Date.now();
    await app.inject({
      method: 'POST', url: '/api/v1/users', headers: authHeaders(adminToken),
      payload: { name: 'Suporte Teste', login, password: 'senha123456', role: 'support' },
    });
    const loginRes = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login, password: 'senha123456' } });
    const supportToken = JSON.parse(loginRes.body).token;

    const res = await app.inject({ method: 'GET', url: '/api/v1/users', headers: authHeaders(supportToken) });
    assert.equal(res.statusCode, 403);
  });

  await t.test('limpeza de dados de demonstração exige confirmação forte e papel admin', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/admin/wipe-demo-data', headers: authHeaders(adminToken), payload: {} });
    assert.equal(res.statusCode, 400, 'sem o texto de confirmação exato, deve recusar');
  });
});
