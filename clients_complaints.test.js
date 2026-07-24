'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, loginAsAdmin, authHeaders } = require('./helpers');

test('clientes centralizados e reclamações', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());
  const token = await loginAsAdmin(app);
  const h = authHeaders(token);

  let clientId;

  await t.test('cadastra cliente central com sucesso', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/clients', headers: h,
      payload: { name: 'Cliente Central de Teste ' + Date.now() },
    });
    assert.equal(res.statusCode, 201, res.body);
    clientId = JSON.parse(res.body).id;
    assert.ok(clientId);
  });

  await t.test('lista de clientes carrega corretamente (usada por Chamados/Reclamações/Devoluções/RMA)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/clients', headers: h });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.data));
    assert.ok(body.data.some(c => c.id === clientId), 'cliente recém-criado deve aparecer na listagem');
  });

  await t.test('impede duplicidade de CNPJ entre clientes', async () => {
    // Gera um CNPJ com 14 dígitos únicos por execução (o backend valida
    // apenas formato de 14 dígitos e unicidade, não dígito verificador —
    // ver POST /clients em server.js).
    const unique = String(Date.now()).slice(-8);
    const cnpj = `99.${unique.slice(0,3)}.${unique.slice(3,6)}/0001-${unique.slice(6,8)}`;
    const first = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: h, payload: { name: 'Empresa A', cnpj } });
    assert.equal(first.statusCode, 201, first.body);
    const second = await app.inject({ method: 'POST', url: '/api/v1/clients', headers: h, payload: { name: 'Empresa B (CNPJ duplicado)', cnpj } });
    assert.equal(second.statusCode, 409);
  });

  await t.test('cria reclamação vinculada ao cliente central por client_id', async () => {
    const res = await app.inject({
      method: 'POST', url: '/api/v1/complaints', headers: h,
      payload: { client_id: clientId, business_unit_id: 'led', type_key: 'other', severity: 'medium', reason: 'Motivo de teste automatizado da reclamação', responsible_area: 'cso' },
    });
    assert.equal(res.statusCode, 201, res.body);
    const complaint = JSON.parse(res.body);
    assert.equal(complaint.client_id, clientId);
    assert.equal(complaint.reason, 'Motivo de teste automatizado da reclamação');
  });

  await t.test('o motivo da reclamação aparece na listagem (GET /complaints)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/complaints', headers: h });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    const found = body.data.find(c => c.client_id === clientId);
    assert.ok(found, 'reclamação recém-criada deve aparecer na listagem');
    assert.ok(found.reason && found.reason.length > 0, 'campo reason deve estar presente e preenchido na listagem');
  });

  await t.test('o motivo da reclamação aparece no detalhe (GET /complaints/:id)', async () => {
    const listRes = await app.inject({ method: 'GET', url: '/api/v1/complaints', headers: h });
    const complaint = JSON.parse(listRes.body).data.find(c => c.client_id === clientId);
    const res = await app.inject({ method: 'GET', url: `/api/v1/complaints/${complaint.id}`, headers: h });
    assert.equal(res.statusCode, 200);
    assert.ok(JSON.parse(res.body).reason);
  });
});
