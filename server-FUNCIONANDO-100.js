require('dotenv').config();
const Fastify = require('fastify');
const cors = require('@fastify/cors');
const helmet = require('@fastify/helmet');
const rateLimit = require('@fastify/rate-limit');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

// ══════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════

const app = Fastify({ logger: true });
const db = new Pool({ connectionString: process.env.DATABASE_URL });
const JWT_SECRET = process.env.JWT_SECRET || 'nextra_cso_hub_2026';
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════
// MIDDLEWARE
// ══════════════════════════════════════════════════════════════

app.register(helmet);
app.register(cors);
app.register(rateLimit, { max: 100, timeWindow: '1 minute' });

// ══════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════

const getUser = (req) => {
  try {
    const auth = req.headers.authorization || '';
    const token = auth.replace('Bearer ', '');
    return jwt.verify(token, JWT_SECRET);
  } catch(e) {
    return null;
  }
};

const authenticate = async (req, reply) => {
  const user = getUser(req);
  if (!user) return reply.code(401).send({ error: 'Unauthorized' });
};

const authorize = (role) => async (req, reply) => {
  const user = getUser(req);
  if (!user || user.role !== role) return reply.code(403).send({ error: 'Forbidden' });
};

// ══════════════════════════════════════════════════════════════
// ROUTES — PUBLIC
// ══════════════════════════════════════════════════════════════

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/v1/auth/login', async (req, reply) => {
  const { login, password } = req.body || {};
  if (!login || !password) return reply.code(400).send({ error: 'Missing credentials' });
  
  try {
    const { rows } = await db.query('SELECT * FROM users WHERE login=$1 AND is_active=TRUE', [login]);
    if (rows.length === 0) return reply.code(401).send({ error: 'Invalid credentials' });
    
    const user = rows[0];
    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return reply.code(401).send({ error: 'Invalid credentials' });
    
    const token = jwt.sign({ sub: user.id, name: user.name, role: user.role }, JWT_SECRET, { expiresIn: '24h' });
    await db.query('UPDATE users SET last_login_at=NOW() WHERE id=$1', [user.id]);
    
    return { token, user: { id: user.id, name: user.name, email: user.email, login: user.login, role: user.role } };
  } catch(e) {
    return reply.code(500).send({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════
// ROUTES — PROTECTED
// ══════════════════════════════════════════════════════════════

app.register(async (v1) => {
  // Users
  v1.get('/users/me', { preHandler: [authenticate] }, async (req) => {
    const user = getUser(req);
    const { rows } = await db.query('SELECT id,name,email,login,role FROM users WHERE id=$1', [user.sub]);
    return rows[0] || {};
  });

  v1.get('/users', { preHandler: [authenticate] }, async (req) => {
    const { rows } = await db.query('SELECT id,name,email,role FROM users ORDER BY name');
    return rows;
  });

  // Tickets
  v1.get('/tickets', { preHandler: [authenticate] }, async (req) => {
    const { rows } = await db.query('SELECT * FROM tickets ORDER BY created_at DESC LIMIT 100');
    return { data: rows };
  });

  v1.post('/tickets', { preHandler: [authenticate] }, async (req, reply) => {
    const d = req.body || {};
    if (!d.client_name || !d.description) return reply.code(400).send({ error: 'Missing fields' });
    
    const user = getUser(req);
    const { rows:[{nextval}] } = await db.query("SELECT nextval('ticket_seq') AS nextval");
    const id = `CSO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(nextval).padStart(4,'0')}`;
    
    try {
      const { rows:[t] } = await db.query(`
        INSERT INTO tickets (id,business_unit_id,client_name,created_by_user_id,
          channel,occurrence_type,criticality,area_responsible,description,
          order_value,revenue_at_risk,status,approval_status,sla_state,reopen_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'new','pending','ok',0) RETURNING *`,
        [id, d.business_unit_id||'led', d.client_name, user.sub,
         d.channel||'whatsapp', d.occurrence_type||'technical_support',
         d.criticality||'medium', d.area_responsible||'support', d.description,
         parseFloat(d.order_value)||null, parseFloat(d.revenue_at_risk)||0]);
      return reply.code(201).send(t);
    } catch(e) {
      return reply.code(500).send({ error: e.message });
    }
  });

  v1.get('/tickets/:id', { preHandler: [authenticate] }, async (req, reply) => {
    const { rows } = await db.query('SELECT * FROM tickets WHERE id=$1', [req.params.id]);
    if (!rows.length) return reply.code(404).send({ error: 'Not found' });
    return rows[0];
  });

  // Dashboard
  v1.get('/dashboard/reports', { preHandler: [authenticate] }, async (req) => {
    const { rows:byStatus } = await db.query('SELECT status, COUNT(*)::int AS count FROM tickets GROUP BY status');
    const { rows:byArea } = await db.query('SELECT area_responsible AS area, COUNT(*)::int AS count FROM tickets GROUP BY area_responsible');
    return { tickets_by_status: byStatus, tickets_by_area: byArea, period_days: 30 };
  });

}, { prefix: '/api/v1' });

// ══════════════════════════════════════════════════════════════
// FRONTEND
// ══════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

app.get('/', async (req, reply) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return reply.code(404).send('index.html not found');
  }
  return reply.type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath, 'utf8'));
});

app.get('/index.html', async (req, reply) => {
  const htmlPath = path.join(__dirname, 'index.html');
  if (!fs.existsSync(htmlPath)) {
    return reply.code(404).send('index.html not found');
  }
  return reply.type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath, 'utf8'));
});

// ══════════════════════════════════════════════════════════════
// START
// ══════════════════════════════════════════════════════════════

const start = async () => {
  try {
    await app.listen({ port: PORT, host: '0.0.0.0' });
    console.log(`✓ Server running at http://0.0.0.0:${PORT}`);
  } catch(e) {
    app.log.error(e);
    process.exit(1);
  }
};

start();
