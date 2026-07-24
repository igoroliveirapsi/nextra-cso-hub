require('dotenv').config();
const { execSync } = require('child_process');
const { Client } = require('pg');

async function startup() {
  console.log('\n══════════════════════════════════════');
  console.log('  Nextra CSO Hub — Iniciando...');
  console.log('══════════════════════════════════════\n');

  // 1. Migrations
  console.log('[1/3] Rodando migrations...');
  try {
    execSync('node migrate.js', { stdio: 'inherit' });
    console.log('✓ Migrations OK\n');
  } catch (e) {
    console.error('✗ Migrations falharam:', e.message);
    process.exit(1);
  }

  // 2. Seed (somente primeira vez)
  console.log('[2/3] Verificando seed...');
  const pg = new Client({ connectionString: process.env.DATABASE_URL });
  try {
    await pg.connect();
    const { rows } = await pg.query("SELECT COUNT(*) AS n FROM users WHERE login='igor'");
    if (parseInt(rows[0].n) === 0) {
      console.log('🌱 Primeiro deploy — rodando seed...');
      execSync('node seed.js', { stdio: 'inherit' });
      console.log('✓ Seed OK\n');
    } else {
      console.log('⏭  Seed já feito. Pulando.\n');
    }
  } catch(e) {
    console.warn('⚠  Aviso seed (não fatal):', e.message, '\n');
  } finally {
    await pg.end().catch(() => {});
  }

  // 3. Servidor
  console.log('[3/3] Iniciando servidor...\n');
  const { buildApp } = require('./server.js');
  const port = parseInt(process.env.PORT || '3001');
  const host = process.env.HOST || '0.0.0.0';
  const app = await buildApp();
  await app.listen({ port, host });
  console.log(`🚀 Nextra CSO Hub rodando em http://${host}:${port}`);
  console.log(`   /health  →  http://${host}:${port}/health\n`);
}

startup().catch(e => { console.error('Startup falhou:', e); process.exit(1); });
