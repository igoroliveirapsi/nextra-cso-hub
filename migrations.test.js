'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Pool } = require('pg');

test('migrations', async (t) => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  t.after(() => pool.end());

  await t.test('migration 010 está registrada como aplicada', async () => {
    const { rows } = await pool.query('SELECT filename FROM schema_migrations WHERE filename = $1', ['010_operational_flow_enhancements.sql']);
    assert.equal(rows.length, 1, 'rode "node migrate.js" antes dos testes (o script pretest já faz isso)');
  });

  await t.test('colunas novas de tickets existem (quantity, product_group, brand)', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='tickets' AND column_name IN ('quantity','product_group','brand')`);
    const names = rows.map(r => r.column_name).sort();
    assert.deepEqual(names, ['brand', 'product_group', 'quantity']);
  });

  await t.test('nf_number em tickets é NOT NULL', async () => {
    const { rows } = await pool.query(`SELECT is_nullable FROM information_schema.columns WHERE table_name='tickets' AND column_name='nf_number'`);
    assert.equal(rows[0].is_nullable, 'NO');
  });

  await t.test('colunas de inspeção existem em returns', async () => {
    const { rows } = await pool.query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name='returns' AND column_name LIKE 'inspection%'`);
    assert.ok(rows.length >= 6, 'devem existir ao menos as 6 colunas de inspeção');
  });

  await t.test('rma.return_id existe e há índice único parcial anti-duplicação', async () => {
    const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name='rma' AND column_name='return_id'`);
    assert.equal(cols.rows.length, 1);
    const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename='rma' AND indexname='uq_rma_active_per_return'`);
    assert.equal(idx.rows.length, 1);
  });
});
