'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, loginAsAdmin, authHeaders } = require('./helpers');

test('chamados', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const token = await loginAsAdmin(app);
  const h = authHeaders(token);

  const basePayload = () => ({
    client_name: 'Cliente Teste Automatizado',
    description: 'Descrição de teste automatizado com mais de dez caracteres.',
    nf_number: 'NF-TESTE-0001',
    quantity: 2,
  });

  await t.test('cria chamado com sucesso quando NF e quantidade são válidas', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload: basePayload() });
    assert.equal(res.statusCode, 201, res.body);
    const ticket = JSON.parse(res.body);
    assert.ok(ticket.id.startsWith('CSO-'));
    assert.equal(ticket.quantity, 2);
    assert.equal(ticket.nf_number, 'NF-TESTE-0001');
  });

  await t.test('rejeita criação sem NF (campo obrigatório)', async () => {
    const payload = basePayload(); payload.nf_number = '';
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 400);
    assert.match(JSON.parse(res.body).message, /nota fiscal|nf/i);
  });

  await t.test('rejeita criação com NF só de espaços em branco', async () => {
    const payload = basePayload(); payload.nf_number = '   ';
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 400);
  });

  await t.test('rejeita quantidade zero', async () => {
    const payload = basePayload(); payload.quantity = 0;
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 400);
  });

  await t.test('rejeita quantidade negativa', async () => {
    const payload = basePayload(); payload.quantity = -3;
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 400);
  });

  await t.test('rejeita quantidade não inteira', async () => {
    const payload = basePayload(); payload.quantity = 1.5;
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 400);
  });

  await t.test('permite quantidade e grupo/marca serem persistidos', async () => {
    const payload = basePayload();
    payload.product_group = 'Painéis LED';
    payload.brand = 'Nextra';
    payload.quantity = 5;
    const res = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload });
    assert.equal(res.statusCode, 201);
    const ticket = JSON.parse(res.body);
    assert.equal(ticket.product_group, 'Painéis LED');
    assert.equal(ticket.brand, 'Nextra');
    assert.equal(ticket.quantity, 5);
  });

  await t.test('edição de chamado aberto funciona e gera histórico', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload: basePayload() });
    const ticket = JSON.parse(createRes.body);

    const patchRes = await app.inject({
      method: 'PATCH', url: `/api/v1/tickets/${ticket.id}`, headers: h,
      payload: { quantity: 9, brand: 'MarcaEditada' },
    });
    assert.equal(patchRes.statusCode, 200, patchRes.body);
    const updated = JSON.parse(patchRes.body);
    assert.equal(updated.quantity, 9);
    assert.equal(updated.brand, 'MarcaEditada');

    const histRes = await app.inject({ method: 'GET', url: `/api/v1/tickets/${ticket.id}/history`, headers: h });
    assert.equal(histRes.statusCode, 200);
    const history = JSON.parse(histRes.body);
    const fieldsChanged = history.map(hh => hh.field_changed).filter(Boolean);
    assert.ok(fieldsChanged.includes('quantity'), 'histórico deve registrar mudança de quantity');
    assert.ok(fieldsChanged.includes('brand'), 'histórico deve registrar mudança de brand');
  });

  await t.test('edição não pode deixar NF em branco', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload: basePayload() });
    const ticket = JSON.parse(createRes.body);
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}`, headers: h, payload: { nf_number: '   ' } });
    assert.equal(res.statusCode, 400);
  });

  await t.test('bloqueia edição de chamado encerrado (exige reabertura)', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload: basePayload() });
    const ticket = JSON.parse(createRes.body);

    // Percorre o fluxo mínimo até poder encerrar.
    await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'in_triage' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'in_technical_analysis' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'in_resolution' } });
    await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'resolved' } });
    await app.inject({
      method: 'PATCH', url: `/api/v1/tickets/${ticket.id}`, headers: h,
      payload: { root_cause_category: 'other', root_cause_description: 'Causa de teste', resolution: 'Resolução de teste' },
    });
    await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/approve`, headers: h, payload: { result: 'approved' } });
    const closeRes = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'closed' } });
    assert.equal(closeRes.statusCode, 200, closeRes.body);

    const editRes = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}`, headers: h, payload: { brand: 'NaoDeveSalvar' } });
    assert.equal(editRes.statusCode, 409, editRes.body);
  });

  await t.test('bloqueia transição de status inválida (necessário para o Kanban)', async () => {
    const createRes = await app.inject({ method: 'POST', url: '/api/v1/tickets', headers: h, payload: basePayload() });
    const ticket = JSON.parse(createRes.body);
    // 'new' só pode ir para 'in_triage' — pular direto para 'closed' deve falhar.
    const res = await app.inject({ method: 'PATCH', url: `/api/v1/tickets/${ticket.id}/status`, headers: h, payload: { status: 'closed' } });
    assert.equal(res.statusCode, 409);
    assert.equal(JSON.parse(res.body).error, 'INVALID_TRANSITION');
  });

  await t.test('exportação Excel retorna um arquivo xlsx válido', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets/export/xlsx', headers: h });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    assert.match(res.headers['content-disposition'], /chamados_\d{4}-\d{2}-\d{2}\.xlsx/);
    assert.ok(res.rawPayload.length > 0, 'o arquivo exportado não pode estar vazio');
  });
});
