'use strict';
// Helper compartilhado pelos testes. Constrói a aplicação Fastify real
// (mesmo buildApp usado em produção) e expõe um helper de login.
//
// Requer DATABASE_URL apontando para um banco de testes descartável, com
// as migrations já aplicadas (rode `node migrate.js` antes — o script
// "pretest" do package.json já faz isso automaticamente) e o seed padrão
// (`node seed.js`) para o login admin/igor existir.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test_secret_nao_usar_em_producao';
process.env.NODE_ENV = process.env.NODE_ENV || 'test';

const { buildApp } = require('../server.js');

async function makeApp() {
  const app = await buildApp();
  await app.ready();
  return app;
}

async function loginAsAdmin(app) {
  const res = await app.inject({
    method: 'POST', url: '/api/v1/auth/login',
    payload: { login: 'igor', password: 'igor@2026' },
  });
  if (res.statusCode !== 200) {
    throw new Error(`Login de teste falhou (${res.statusCode}): ${res.body}. Rode 'node seed.js' antes dos testes.`);
  }
  return JSON.parse(res.body).token;
}

function authHeaders(token) {
  return { authorization: `Bearer ${token}` };
}

module.exports = { makeApp, loginAsAdmin, authHeaders };
