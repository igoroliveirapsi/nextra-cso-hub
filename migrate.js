require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

const MIGRATIONS = [
  '001_schema.sql',
  '002_seeds.sql',
  '003_cs_layer_v2.1.sql',
  '004_full_version_1_0.sql',
  '005_v1_1_enhancements.sql',
];

async function migrate() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // Cria tabela de controle de migrations (idempotente)
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);

    // Busca quais já foram aplicadas
    const { rows: applied } = await client.query('SELECT filename FROM schema_migrations');
    const appliedSet = new Set(applied.map(r => r.filename));

    for (const file of MIGRATIONS) {
      if (appliedSet.has(file)) {
        console.log(`  ⏭  ${file} (já aplicada, pulando)`);
        continue;
      }

      const filePath = path.join(__dirname, file);
      if (!fs.existsSync(filePath)) {
        console.error(`✗ Arquivo não encontrado: ${file}`);
        process.exit(1);
      }
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`  ▶ ${file}...`);
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename) VALUES ($1)', [file]);
        console.log(`  ✓ ${file}`);
      } catch (e) {
        // Se a tabela/objeto já existe (de uma execução manual anterior),
        // marca como aplicada e segue em frente, em vez de derrubar o deploy.
        if (e.message.includes('already exists')) {
          console.warn(`  ⚠ ${file} — objetos já existiam no banco (${e.message}). Marcando como aplicada.`);
          // CRÍTICO: a string SQL falhou no meio, deixando a sessão em estado de
          // "transação abortada". Sem o ROLLBACK abaixo, o INSERT seguinte também
          // falha (current transaction is aborted) e derruba o processo inteiro.
          await client.query('ROLLBACK').catch(() => {});
          await client.query(
            'INSERT INTO schema_migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING',
            [file]
          );
        } else {
          await client.query('ROLLBACK').catch(() => {});
          throw e;
        }
      }
    }
    console.log('\n✅ Migrations verificadas/aplicadas com sucesso.');
  } catch (e) {
    console.error('✗ Migration falhou:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
