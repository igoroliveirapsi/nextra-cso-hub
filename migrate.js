require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

// SQL files are in the same folder
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
    for (const file of MIGRATIONS) {
      const filePath = path.join(__dirname, file);
      if (!fs.existsSync(filePath)) {
        console.error(`✗ Arquivo não encontrado: ${file}`);
        process.exit(1);
      }
      const sql = fs.readFileSync(filePath, 'utf8');
      console.log(`  ▶ ${file}...`);
      await client.query(sql);
      console.log(`  ✓ ${file}`);
    }
    console.log('\n✅ Todas as migrations aplicadas.');
  } catch (e) {
    console.error('✗ Migration falhou:', e.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

migrate();
