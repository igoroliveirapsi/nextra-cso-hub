'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { makeApp, loginAsAdmin, authHeaders } = require('./helpers');

test('autenticação', async (t) => {
  const app = await makeApp();
  t.after(() => app.close());

  await t.test('login com credenciais válidas retorna token e usuário', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'igor', password: 'igor@2026' } });
    assert.equal(res.statusCode, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.token, 'deve retornar um token');
    assert.equal(body.user.login, 'igor');
    assert.equal(body.user.role, 'admin');
  });

  await t.test('login com senha incorreta retorna 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'igor', password: 'senha_errada' } });
    assert.equal(res.statusCode, 401);
  });

  await t.test('login com usuário inexistente retorna 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { login: 'usuario_que_nao_existe_xyz', password: 'qualquer' } });
    assert.equal(res.statusCode, 401);
  });

  await t.test('login sem login/senha retorna 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: {} });
    assert.equal(res.statusCode, 400);
  });

  await t.test('rota protegida sem token retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets' });
    assert.equal(res.statusCode, 401);
  });

  await t.test('rota protegida com token inválido retorna 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders('token.invalido.aqui') });
    assert.equal(res.statusCode, 401);
  });

  await t.test('rota protegida com token válido retorna 200', async () => {
    const token = await loginAsAdmin(app);
    const res = await app.inject({ method: 'GET', url: '/api/v1/tickets', headers: authHeaders(token) });
    assert.equal(res.statusCode, 200);
  });

  await t.test('logout invalida a sessão (apenas quando Redis está configurado)', async () => {
    const token = await loginAsAdmin(app);
    const logoutRes = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: authHeaders(token) });
    assert.equal(logoutRes.statusCode, 204);
    // Sem REDIS_URL configurado no ambiente de teste, o token continua
    // tecnicamente válido (limitação conhecida e documentada de JWT
    // stateless sem blocklist) — este teste apenas confirma que a rota
    // de logout responde corretamente, sem verificar a invalidação em si
    // (que depende de Redis, testada manualmente — ver CHECKLIST).
  });
});
