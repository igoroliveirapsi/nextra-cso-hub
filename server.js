'use strict';
require('dotenv').config();
const path = require('path');
const fs   = require('fs');
const Fastify = require('fastify');
const cors    = require('@fastify/cors');
const helmet  = require('@fastify/helmet');
const rl      = require('@fastify/rate-limit');
const { Pool }   = require('pg');
const Redis      = require('ioredis');
const jwt        = require('jsonwebtoken');
const bcrypt     = require('bcryptjs');
const { z }      = require('zod');

// ── DB ─────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = {
  query: (sql, params) => pool.query(sql, params),
  healthCheck: async () => { try { await pool.query('SELECT 1'); return true; } catch { return false; } }
};

// ── JWT helpers ────────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET || 'nextra_cso_dev_secret';
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';
const signToken   = (payload) => jwt.sign(payload, JWT_SECRET, { expiresIn: JWT_EXPIRES });
const verifyToken = (token)   => jwt.verify(token, JWT_SECRET);

// ── Auth middleware ────────────────────────────────────────────
async function authenticate(req, reply) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Token obrigatório.', status: 401 });
  try {
    const payload = verifyToken(token);
    req.user = payload;
  } catch {
    return reply.code(401).send({ error: 'TOKEN_INVALID', message: 'Token inválido ou expirado.', status: 401 });
  }
}

function authorize(...roles) {
  return async (req, reply) => {
    await authenticate(req, reply);
    if (reply.sent) return;
    if (!roles.includes(req.user?.role)) {
      return reply.code(403).send({ error: 'FORBIDDEN', message: 'Permissão insuficiente.', status: 403 });
    }
  };
}

const getUser = (req) => req.user;

async function auditLog(req, action, table, recordId, oldData, newData) {
  try {
    const user = req.user;
    await db.query(
      `INSERT INTO audit_log (user_id, user_role, action, table_name, record_id, old_data, new_data, ip_address)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user?.sub || null, user?.role || null, action, table, String(recordId),
       oldData ? JSON.stringify(oldData) : null,
       newData ? JSON.stringify(newData) : null,
       req.ip || null]
    );
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────
const send404 = (reply) => reply.code(404).send({ error: 'NOT_FOUND', status: 404 });
const send422 = (reply, msg, code) => reply.code(422).send({ error: code, message: msg, status: 422 });

// ── Build Fastify app ──────────────────────────────────────────
async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
    trustProxy: true,
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  await app.register(cors, {
    origin: (origin, cb) => cb(null, true),
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    credentials: true,
  });

  await app.register(rl, {
    max: 200, timeWindow: 60000,
    errorResponseBuilder: () => ({ error: 'RATE_LIMIT_EXCEEDED', status: 429 }),
  });

  // Redis opcional
  let redis = null;
  if (process.env.REDIS_URL) {
    try {
      redis = new Redis(process.env.REDIS_URL, { lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 3000 });
      await redis.connect();
    } catch { redis = null; }
  }

  // ── Health ─────────────────────────────────────────────────
  app.get('/health', async () => {
    const dbOk = await db.healthCheck();
    const redisOk = redis ? await redis.ping().then(()=>true).catch(()=>false) : null;
    return { status: dbOk ? 'ok' : 'degraded', db: dbOk ? 'ok' : 'error',
      redis: redisOk === null ? 'not_configured' : redisOk ? 'ok' : 'error',
      env: process.env.NODE_ENV || 'development', timestamp: new Date().toISOString() };
  });

  // ── Frontend ───────────────────────────────────────────────
  const htmlPath = path.join(__dirname, 'index.html');
  app.get('/', async (_req, reply) => {
    if (!fs.existsSync(htmlPath)) return reply.code(404).send('index.html not found');
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath, 'utf8'));
  });
  app.get('/index.html', async (_req, reply) => {
    if (!fs.existsSync(htmlPath)) return reply.code(404).send('index.html not found');
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(htmlPath, 'utf8'));
  });

  // ══════════════════════════════════════════════════════════
  //  ROUTES — /api/v1
  // ══════════════════════════════════════════════════════════
  app.register(async (v1) => {

    // ── AUTH ──────────────────────────────────────────────
    v1.post('/auth/login', async (req, reply) => {
      const { login, password } = req.body || {};
      if (!login || !password) return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Login e senha obrigatórios.', status: 400 });
      const { rows } = await db.query('SELECT * FROM users WHERE login=$1', [login]);
      const user = rows[0];
      if (!user) return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Usuário não encontrado.', status: 401 });
      if (!user.is_active) return reply.code(401).send({ error: 'INACTIVE_USER', message: 'Usuário inativo.', status: 401 });
      const ok = await bcrypt.compare(String(password), user.password_hash);
      if (!ok) return reply.code(401).send({ error: 'INVALID_CREDENTIALS', message: 'Senha incorreta.', status: 401 });
      const token = signToken({ sub: user.id, login: user.login, role: user.role, name: user.name });
      return { token, user: { id: user.id, login: user.login, name: user.name, role: user.role, title: user.title } };
    });

    v1.post('/auth/logout', { preHandler: [authenticate] }, async (_req, reply) => {
      return reply.code(204).send();
    });

    // ── CONFIG ─────────────────────────────────────────────
    v1.get('/config', async () => ({
      statuses: { new:'Novo', in_triage:'Em triagem', awaiting_info:'Aguard. info.',
        in_technical_analysis:'Análise técnica', awaiting_cd_ops:'Aguard. CD',
        awaiting_supplier:'Aguard. fornecedor', awaiting_fiscal:'Aguard. fiscal',
        in_resolution:'Em solução', awaiting_client_validation:'Aguard. cliente',
        resolved:'Resolvido', closed:'Encerrado', reopened:'Reaberto' },
      criticalities: { critical:'Crítica', high:'Alta', medium:'Média', low:'Baixa' },
      roles: { admin:'Admin', cso:'CSO', support:'Suporte', rma:'RMA',
        warehouse:'CD', fiscal:'Fiscal', sales:'Comercial', operations:'Operações', board:'Board' },
    }));

    v1.get('/config/complaint-types', async () => {
      const { rows } = await db.query('SELECT * FROM complaint_type_config ORDER BY label').catch(() => ({ rows: [] }));
      return rows;
    });

    v1.get('/config/sla', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query('SELECT * FROM sla_config ORDER BY criticality').catch(() => ({ rows: [] }));
      return rows;
    });

    // ── USERS ──────────────────────────────────────────────
    v1.get('/users/me', { preHandler: [authenticate] }, async (req) => {
      const { rows } = await db.query('SELECT id,name,email,login,role,title FROM users WHERE id=$1', [getUser(req).sub]);
      return rows[0] || {};
    });

    v1.get('/users', { preHandler: [authorize('admin')] }, async (req) => {
      const { rows } = await db.query('SELECT id,name,email,login,role,title,is_active,created_at FROM users ORDER BY name');
      return rows;
    });

    // ── TICKETS ────────────────────────────────────────────
    v1.get('/tickets', { preHandler: [authenticate] }, async (req) => {
      const { status, criticality, area_responsible, q, page='1', limit='100' } = req.query || {};
      const offset = (parseInt(page)-1)*parseInt(limit);
      const where = ['1=1']; const params = [];
      if (status)           { params.push(status);     where.push(`t.status=$${params.length}`); }
      if (criticality)      { params.push(criticality); where.push(`t.criticality=$${params.length}`); }
      if (area_responsible) { params.push(area_responsible); where.push(`t.area_responsible=$${params.length}`); }
      if (q) { params.push(`%${q}%`); where.push(`(t.client_name ILIKE $${params.length} OR t.id ILIKE $${params.length})`); }
      params.push(parseInt(limit), offset);
      const { rows } = await db.query(
        `SELECT t.* FROM tickets t WHERE ${where.join(' AND ')} ORDER BY
         CASE t.criticality WHEN 'critical' THEN 1 WHEN 'high' THEN 2 WHEN 'medium' THEN 3 ELSE 4 END,
         t.created_at DESC LIMIT $${params.length-1} OFFSET $${params.length}`,
        params
      );
      return { data: rows };
    });

    v1.post('/tickets', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_name || !d.description || d.description.length < 10)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'cliente e descrição (mín. 10 chars) obrigatórios.', status:400 });
      const user = getUser(req);
      const { rows: [{nextval}] } = await db.query("SELECT nextval('ticket_seq') AS nextval");
      const ticketId = `CSO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(nextval).padStart(4,'0')}`;
      const slaHours = { critical:8, high:24, medium:48, low:96 }[d.criticality||'medium']||48;
      const slaDeadline = new Date(Date.now() + slaHours*3600000);
      const { rows:[ticket] } = await db.query(`
        INSERT INTO tickets (id, business_unit_id, client_id, client_name, created_by_user_id,
          channel, occurrence_type, criticality, area_responsible, description,
          order_number, order_value, revenue_at_risk, is_vip, is_recurrence,
          sla_deadline, sla_state, status, approval_status, reopen_count)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'ok','new','pending',0)
        RETURNING *`,
        [ticketId, d.business_unit_id||'led', d.client_id||null, d.client_name, user.sub,
         d.channel||'whatsapp', d.occurrence_type||'technical_support',
         d.criticality||'medium', d.area_responsible||'support', d.description,
         d.order_number||null, d.order_value||null, d.revenue_at_risk||0,
         d.is_vip||false, d.is_recurrence||false, slaDeadline.toISOString()]
      );
      await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action) VALUES ($1,$2,'ticket_aberto')`, [ticketId, user.sub]);
      return reply.code(201).send(ticket);
    });

    v1.get('/tickets/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query('SELECT t.* FROM tickets t WHERE t.id=$1', [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/tickets/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const d = req.body || {};
      const allowed = ['root_cause_category','root_cause_description','resolution','preventive_action',
        'area_responsible','responsible_user_id','revenue_at_risk','order_number','order_value'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k));
      if (!fields.length) return t;
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      const { rows:[u] } = await db.query(
        `UPDATE tickets SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, ...fields.map(([,v])=>v)]
      );
      return u;
    });

    v1.patch('/tickets/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note } = req.body || {};
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const user = getUser(req);
      if (user.role === 'board') return reply.code(403).send({ error:'BOARD_READ_ONLY', status:403 });
      if (newStatus === 'closed') {
        if (!t.root_cause_description) return send422(reply, 'Causa raiz obrigatória para encerrar.', 'MISSING_ROOT_CAUSE');
        if (!t.resolution)             return send422(reply, 'Resolução obrigatória para encerrar.', 'MISSING_RESOLUTION');
        if (t.approval_status !== 'approved') return send422(reply, 'Chancela obrigatória para encerrar.', 'APPROVAL_REQUIRED');
        if (t.reopen_count >= 2 && !t.preventive_action) return send422(reply, 'Ação preventiva obrigatória.', 'PREVENTIVE_ACTION_REQUIRED');
      }
      const slaPauseStatuses = ['awaiting_info','awaiting_supplier','awaiting_fiscal','awaiting_client_validation'];
      let slaState = t.sla_state;
      if (['closed','resolved'].includes(newStatus)) slaState = 'done';
      else if (slaPauseStatuses.includes(newStatus)) slaState = 'paused';
      else if (t.sla_deadline && new Date(t.sla_deadline) < new Date()) slaState = 'overdue';
      const resolvedAt = newStatus === 'resolved' ? 'NOW()' : null;
      const closedAt   = newStatus === 'closed'   ? 'NOW()' : null;
      const { rows:[u] } = await db.query(`
        UPDATE tickets SET status=$2, sla_state=$3,
          resolved_at = CASE WHEN $4::text IS NOT NULL THEN NOW() ELSE resolved_at END,
          closed_at   = CASE WHEN $5::text IS NOT NULL THEN NOW() ELSE closed_at END,
          updated_at  = NOW()
        WHERE id=$1 RETURNING *`,
        [id, newStatus, slaState, resolvedAt, closedAt]
      );
      await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action,note) VALUES ($1,$2,$3,$4)`,
        [id, user.sub, `status: ${t.status} → ${newStatus}`, note||null]);
      return u;
    });

    v1.patch('/tickets/:id/approve', { preHandler: [authorize('admin','cso','board')] }, async (req, reply) => {
      const { id } = req.params;
      const { result='approved', comment } = req.body || {};
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const user = getUser(req);
      const { rows:[u] } = await db.query(
        `UPDATE tickets SET approval_status=$2, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, result]
      );
      await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action,note) VALUES ($1,$2,$3,$4)`,
        [id, user.sub, `chancela: ${result}`, comment||null]);
      return u;
    });

    v1.post('/tickets/:id/reopen', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const { rows:[u] } = await db.query(`
        UPDATE tickets SET status='reopened', approval_status='pending',
          root_cause_description=NULL, resolution=NULL, preventive_action=NULL,
          reopen_count=reopen_count+1, resolved_at=NULL, closed_at=NULL, updated_at=NOW()
        WHERE id=$1 RETURNING *`, [id]);
      await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action) VALUES ($1,$2,'reaberto')`,
        [id, getUser(req).sub]);
      return u;
    });

    v1.get('/tickets/:id/history', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(`
        SELECT h.*, u.name AS user_name FROM ticket_history h
        LEFT JOIN users u ON u.id = h.user_id
        WHERE h.ticket_id=$1 ORDER BY h.created_at DESC`, [req.params.id]);
      return rows;
    });

    v1.post('/tickets/:id/notes', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { note } = req.body || {};
      if (!note?.trim()) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota obrigatória.', status:400 });
      const { rows:[t] } = await db.query('SELECT id FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action,note) VALUES ($1,$2,'nota_interna',$3)`,
        [id, getUser(req).sub, note.trim()]);
      return reply.code(201).send({ message: 'Nota adicionada.' });
    });

    // ── COMPLAINTS ─────────────────────────────────────────
    v1.get('/complaints', { preHandler: [authenticate] }, async (req) => {
      const { status, severity, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)   { params.push(status);   where.push(`c.status=$${params.length}`); }
      if (severity) { params.push(severity); where.push(`c.severity=$${params.length}`); }
      if (client_id){ params.push(parseInt(client_id)); where.push(`c.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT c.*, cl.name AS client_name FROM complaints c
         LEFT JOIN clients cl ON cl.id=c.client_id
         WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC`, params);
      return { data: rows };
    });

    v1.post('/complaints', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.reason) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e reason obrigatórios.', status:400 });
      const user = getUser(req);
      const { rows:[c] } = await db.query(`
        INSERT INTO complaints (client_id, business_unit_id, type_key, severity, procedence,
          reason, responsible_area, loss_risk, ticket_id, channel, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [d.client_id, d.business_unit_id||'led', d.type_key||'other', d.severity||'medium',
         d.procedence||'under_analysis', d.reason, d.responsible_area||'cso',
         d.loss_risk||0, d.ticket_id||null, d.channel||null, user.sub]);
      return reply.code(201).send(c);
    });

    v1.get('/complaints/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT c.*, cl.name AS client_name,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT ch.*, u.name AS user_name FROM complaint_history ch
             LEFT JOIN users u ON u.id=ch.user_id WHERE ch.complaint_id=c.id) h) AS history
         FROM complaints c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/complaints/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows:[c] } = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
      if (!c) return send404(reply);
      const d = req.body || {};
      const allowed = ['recovery_action','resolution','loss_risk','responsible_area','procedence','client_feeling'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k));
      if (!fields.length) return c;
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      const { rows:[u] } = await db.query(`UPDATE complaints SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, ...fields.map(([,v])=>v)]);
      return u;
    });

    v1.patch('/complaints/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note } = req.body || {};
      const { rows:[c] } = await db.query('SELECT * FROM complaints WHERE id=$1', [id]);
      if (!c) return send404(reply);
      if (newStatus === 'closed' && !c.resolution)
        return send422(reply, 'Resolução obrigatória para encerrar.', 'MISSING_RESOLUTION');
      const { rows:[u] } = await db.query(`
        UPDATE complaints SET status=$2,
          closed_at=CASE WHEN $2 IN ('closed','cancelled') THEN NOW() ELSE closed_at END,
          updated_at=NOW() WHERE id=$1 RETURNING *`, [id, newStatus]);
      await db.query(`INSERT INTO complaint_history (complaint_id,user_id,action,note) VALUES ($1,$2,$3,$4)`,
        [id, getUser(req).sub, `status: ${c.status} → ${newStatus}`, note||null]);
      return u;
    });

    v1.post('/complaints/:id/notes', { preHandler: [authenticate] }, async (req, reply) => {
      const { note } = req.body || {};
      if (!note?.trim()) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota obrigatória.', status:400 });
      const { rows:[c] } = await db.query('SELECT id FROM complaints WHERE id=$1', [req.params.id]);
      if (!c) return send404(reply);
      await db.query(`INSERT INTO complaint_history (complaint_id,user_id,action,note) VALUES ($1,$2,'nota_interna',$3)`,
        [req.params.id, getUser(req).sub, note.trim()]);
      return reply.code(201).send({ message:'Nota adicionada.' });
    });

    v1.post('/complaints/:id/create-ticket', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows:[c] } = await db.query(
        'SELECT c.*,cl.name AS client_name FROM complaints c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.id=$1',
        [req.params.id]);
      if (!c) return send404(reply);
      const user = getUser(req);
      const { rows:[{nextval}] } = await db.query("SELECT nextval('ticket_seq') AS nextval");
      const ticketId = `CSO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(nextval).padStart(4,'0')}`;
      const { rows:[t] } = await db.query(`
        INSERT INTO tickets (id,business_unit_id,client_id,client_name,created_by_user_id,
          channel,occurrence_type,criticality,area_responsible,description,sla_deadline,sla_state)
        VALUES ($1,$2,$3,$4,$5,'portal','complaint_followup',$6,$7,$8,NOW()+INTERVAL '48 hours','ok') RETURNING *`,
        [ticketId,c.business_unit_id,c.client_id,c.client_name,user.sub,c.severity,c.responsible_area,
         `[RECLAMAÇÃO #${c.id}] ${c.reason}`]);
      await db.query('UPDATE complaints SET ticket_id=$1 WHERE id=$2', [ticketId, c.id]);
      return reply.code(201).send({ ticket: t, complaint_id: c.id });
    });

    // ── RETURNS ────────────────────────────────────────────
    v1.get('/returns', { preHandler: [authenticate] }, async (req) => {
      const { status, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)    { params.push(status);           where.push(`r.status=$${params.length}`); }
      if (client_id) { params.push(parseInt(client_id)); where.push(`r.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name FROM returns r
         LEFT JOIN clients cl ON cl.id=r.client_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params);
      return { data: rows };
    });

    v1.post('/returns', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.reason) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e reason obrigatórios.', status:400 });
      const { rows:[r] } = await db.query(`
        INSERT INTO returns (client_id,business_unit_id,reason,quantity,product_name_snap,
          unit_value,order_number,nf_number,ticket_id,responsible_user_id,status)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'return_requested') RETURNING *`,
        [d.client_id,d.business_unit_id||'led',d.reason,d.quantity||1,
         d.product_name||null,d.unit_value||d.total_value||null,
         d.order_number||null,d.nf_number||null,d.ticket_id||null,
         d.responsible_user_id||getUser(req).sub]);
      await db.query(`INSERT INTO return_history (return_id,user_id,action) VALUES ($1,$2,'return_created')`,
        [r.id, getUser(req).sub]);
      return reply.code(201).send(r);
    });

    v1.get('/returns/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT rh.*,u.name AS user_name FROM return_history rh
             LEFT JOIN users u ON u.id=rh.user_id WHERE rh.return_id=r.id) h) AS history
         FROM returns r LEFT JOIN clients cl ON cl.id=r.client_id WHERE r.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/returns/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note, reject_reason, decision } = req.body || {};
      const { rows:[r] } = await db.query('SELECT * FROM returns WHERE id=$1', [id]);
      if (!r) return send404(reply);
      if (newStatus === 'rejected' && !reject_reason)
        return send422(reply, 'Motivo da rejeição obrigatório.', 'REJECT_REASON_REQUIRED');
      const { rows:[u] } = await db.query(`
        UPDATE returns SET status=$2,
          reject_reason=COALESCE($3,reject_reason),
          decision=COALESCE($4::return_decision,decision),
          closed_at=CASE WHEN $2 IN ('closed','rejected') AND closed_at IS NULL THEN NOW() ELSE closed_at END,
          updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, newStatus, reject_reason||null, decision||null]);
      try {
        await db.query(`INSERT INTO return_history (return_id,user_id,action,note) VALUES ($1,$2,$3,$4)`,
          [id, getUser(req).sub, `status: ${r.status} → ${newStatus}`, note||null]);
      } catch {}
      return u;
    });

    v1.post('/returns/:id/notes', { preHandler: [authenticate] }, async (req, reply) => {
      const { note } = req.body || {};
      if (!note?.trim()) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota obrigatória.', status:400 });
      const { rows:[r] } = await db.query('SELECT id FROM returns WHERE id=$1', [req.params.id]);
      if (!r) return send404(reply);
      await db.query(`INSERT INTO return_history (return_id,user_id,action,note) VALUES ($1,$2,'nota_interna',$3)`,
        [req.params.id, getUser(req).sub, note.trim()]);
      return reply.code(201).send({ message:'Nota adicionada.' });
    });

    // ── RMA ────────────────────────────────────────────────
    v1.get('/rma', { preHandler: [authenticate] }, async (req) => {
      const { status, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)    { params.push(status);           where.push(`r.status=$${params.length}`); }
      if (client_id) { params.push(parseInt(client_id)); where.push(`r.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name FROM rma r
         LEFT JOIN clients cl ON cl.id=r.client_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params);
      return { data: rows };
    });

    v1.post('/rma', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.product_name || !d.defect_description) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'product_name e defect_description obrigatórios.', status:400 });
      const user = getUser(req);
      const { rows:[r] } = await db.query(`
        INSERT INTO rma (client_id,business_unit_id,ticket_id,product_name,product_code,
          serial_number,defect_description,warranty,responsible_user_id,created_by_user_id)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [d.client_id||null,d.business_unit_id||'led',d.ticket_id||null,d.product_name,
         d.product_code||null,d.serial_number||null,d.defect_description,
         d.warranty||false,d.responsible_user_id||user.sub,user.sub]);
      await db.query(`INSERT INTO rma_history (rma_id,user_id,action,new_status) VALUES ($1,$2,'rma_criado','requested')`,
        [r.id, user.sub]);
      return reply.code(201).send(r);
    });

    v1.get('/rma/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT rh.*,u.name AS user_name FROM rma_history rh
             LEFT JOIN users u ON u.id=rh.user_id WHERE rh.rma_id=r.id) h) AS history
         FROM rma r LEFT JOIN clients cl ON cl.id=r.client_id WHERE r.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/rma/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note, decision } = req.body || {};
      const { rows:[r] } = await db.query('SELECT * FROM rma WHERE id=$1', [id]);
      if (!r) return send404(reply);
      const { rows:[u] } = await db.query(`
        UPDATE rma SET status=$2,
          rma_decision_v1=COALESCE($3::rma_decision_v1,rma_decision_v1),
          received_at=CASE WHEN $2='received' AND received_at IS NULL THEN NOW() ELSE received_at END,
          closed_at=CASE WHEN $2 IN ('closed','rejected') AND closed_at IS NULL THEN NOW() ELSE closed_at END,
          updated_at=NOW() WHERE id=$1 RETURNING *`, [id, newStatus, decision||null]);
      await db.query(`INSERT INTO rma_history (rma_id,user_id,action,old_status,new_status,note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, getUser(req).sub, `status: ${r.status} → ${newStatus}`, r.status, newStatus, note||null]);
      return u;
    });

    v1.patch('/rma/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { technical_notes, decision_notes } = req.body || {};
      const { rows:[u] } = await db.query(
        `UPDATE rma SET technical_notes=COALESCE($2,technical_notes),decision_notes=COALESCE($3,decision_notes),updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, technical_notes||null, decision_notes||null]);
      if (!u) return send404(reply);
      return u;
    });

    v1.post('/rma/:id/notes', { preHandler: [authenticate] }, async (req, reply) => {
      const { note } = req.body || {};
      if (!note?.trim()) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota obrigatória.', status:400 });
      const { rows:[r] } = await db.query('SELECT id FROM rma WHERE id=$1', [req.params.id]);
      if (!r) return send404(reply);
      await db.query(`INSERT INTO rma_history (rma_id,user_id,action,note) VALUES ($1,$2,'nota_interna',$3)`,
        [req.params.id, getUser(req).sub, note.trim()]);
      return reply.code(201).send({ message:'Nota adicionada.' });
    });

    // ── CLIENTS ────────────────────────────────────────────
    v1.get('/clients', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query(`
        SELECT c.*,u.name AS account_manager_name,
          (SELECT COUNT(*) FROM tickets t WHERE t.client_id=c.id AND t.status NOT IN ('closed'))::int AS open_tickets,
          (SELECT COUNT(*) FROM complaints cp WHERE cp.client_id=c.id AND cp.status NOT IN ('closed','cancelled'))::int AS open_complaints,
          (SELECT COUNT(*) FROM returns r WHERE r.client_id=c.id AND r.status NOT IN ('closed','rejected'))::int AS open_returns,
          (SELECT COUNT(*) FROM rma rm WHERE rm.client_id=c.id AND rm.status NOT IN ('closed','rejected'))::int AS open_rmas,
          COALESCE((SELECT SUM(revenue_at_risk) FROM tickets t WHERE t.client_id=c.id AND t.status NOT IN ('closed')),0) AS revenue_at_risk
        FROM clients c LEFT JOIN users u ON u.id=c.account_manager_id
        WHERE c.is_active=TRUE ORDER BY c.health_score ASC NULLS LAST`);
      return { data: rows };
    });

    v1.get('/clients/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        'SELECT c.*,u.name AS account_manager_name FROM clients c LEFT JOIN users u ON u.id=c.account_manager_id WHERE c.id=$1',
        [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.get('/clients/:id/360', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { rows:[client] } = await db.query('SELECT * FROM clients WHERE id=$1', [id]);
      if (!client) return send404(reply);
      const [tickets,complaints,returns,rmas,csat_d,nps_d,recovery,hlog] = await Promise.all([
        db.query('SELECT id,status,criticality,sla_state,description,revenue_at_risk,occurrence_type,created_at FROM tickets WHERE client_id=$1 ORDER BY created_at DESC LIMIT 20',[id]),
        db.query('SELECT id,type_key,severity,status,reason,loss_risk,created_at FROM complaints WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT id,status,reason,total_value,decision,created_at FROM returns WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT id,status,product_name,defect_description,warranty,rma_decision_v1 AS decision,created_at FROM rma WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT score,comment,collection_date FROM csat WHERE client_id=$1 ORDER BY collection_date DESC LIMIT 10',[id]),
        db.query('SELECT score,nps_type,comment,collection_date FROM nps WHERE client_id=$1 ORDER BY collection_date DESC LIMIT 5',[id]),
        db.query('SELECT id,status,reason,health_score_at_open,target_health_score,next_review_date FROM recovery_plans WHERE client_id=$1 AND status NOT IN (\'completed\',\'cancelled\')',[id]),
        db.query('SELECT health_score,health_status,reason,recorded_at AS changed_at FROM client_health_log WHERE client_id=$1 ORDER BY recorded_at DESC LIMIT 12',[id]),
      ]);
      const open = tickets.rows.filter(t=>t.status!=='closed');
      const csatAvg = csat_d.rows.length ? (csat_d.rows.reduce((s,c)=>s+c.score,0)/csat_d.rows.length).toFixed(1) : null;
      return { client, summary: {
        open_tickets: open.length,
        open_complaints: complaints.rows.filter(c=>!['closed','cancelled'].includes(c.status)).length,
        open_returns: returns.rows.filter(r=>!['closed','rejected'].includes(r.status)).length,
        open_rmas: rmas.rows.filter(r=>!['closed','rejected'].includes(r.status)).length,
        total_revenue_at_risk: open.reduce((s,t)=>s+(t.revenue_at_risk||0),0),
        csat_avg: csatAvg,
      }, tickets:tickets.rows, complaints:complaints.rows, returns:returns.rows, rmas:rmas.rows,
         csat:csat_d.rows, nps:nps_d.rows, recovery_plans:recovery.rows, health_log:hlog.rows };
    });

    v1.get('/clients/:id/health-log', { preHandler: [authenticate] }, async (req) => {
      const { rows } = await db.query('SELECT * FROM client_health_log WHERE client_id=$1 ORDER BY recorded_at DESC LIMIT 50',[req.params.id]);
      return rows;
    });

    // ── CSAT ───────────────────────────────────────────────
    v1.get('/csat', { preHandler: [authenticate] }, async (req) => {
      const { client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (client_id) { params.push(parseInt(client_id)); where.push(`cs.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT cs.*,cl.name AS client_name FROM csat cs LEFT JOIN clients cl ON cl.id=cs.client_id
         WHERE ${where.join(' AND ')} ORDER BY cs.collection_date DESC LIMIT 100`, params);
      const avg = rows.length ? (rows.reduce((s,r)=>s+r.score,0)/rows.length).toFixed(1) : null;
      return { data: rows, csat_avg: avg };
    });

    v1.post('/csat', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.score) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e score obrigatórios.', status:400 });
      const { rows:[c] } = await db.query(`
        INSERT INTO csat (client_id,business_unit_id,score,comment,ticket_id,complaint_id,collected_by,collection_date)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [d.client_id,d.business_unit_id||'led',d.score,d.comment||null,d.ticket_id||null,
         d.complaint_id||null,getUser(req).sub,d.collection_date||new Date().toISOString().slice(0,10)]);
      return reply.code(201).send(c);
    });

    // ── NPS ────────────────────────────────────────────────
    v1.get('/nps', { preHandler: [authenticate] }, async (req) => {
      const { client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (client_id) { params.push(parseInt(client_id)); where.push(`n.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT n.*,cl.name AS client_name FROM nps n LEFT JOIN clients cl ON cl.id=n.client_id
         WHERE ${where.join(' AND ')} ORDER BY n.collection_date DESC LIMIT 100`, params);
      const promoters  = rows.filter(r=>r.nps_type==='promoter').length;
      const detractors = rows.filter(r=>r.nps_type==='detractor').length;
      const score = rows.length ? Math.round(((promoters-detractors)/rows.length)*100) : null;
      return { data:rows, nps_score:score, promoters, detractors, neutrals:rows.length-promoters-detractors };
    });

    v1.post('/nps', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || d.score===undefined) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e score obrigatórios.', status:400 });
      const { rows:[n] } = await db.query(`
        INSERT INTO nps (client_id,business_unit_id,score,comment,collected_by,collection_date)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
        [d.client_id,d.business_unit_id||'led',d.score,d.comment||null,
         getUser(req).sub,d.collection_date||new Date().toISOString().slice(0,10)]);
      return reply.code(201).send(n);
    });

    // ── RECOVERY PLANS ─────────────────────────────────────
    v1.get('/recovery-plans', { preHandler: [authenticate] }, async (req) => {
      const { status, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)    { params.push(status);           where.push(`rp.status=$${params.length}`); }
      if (client_id) { params.push(parseInt(client_id)); where.push(`rp.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT rp.*,cl.name AS client_name,cl.health_score,cl.health_status,u.name AS responsible_name,
           (SELECT json_agg(a ORDER BY a.sort_order) FROM recovery_actions a WHERE a.recovery_plan_id=rp.id) AS actions
         FROM recovery_plans rp LEFT JOIN clients cl ON cl.id=rp.client_id LEFT JOIN users u ON u.id=rp.responsible_user_id
         WHERE ${where.join(' AND ')} ORDER BY rp.created_at DESC`, params);
      return { data: rows };
    });

    v1.get('/recovery-plans/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT rp.*,cl.name AS client_name,cl.health_score,cl.health_status,u.name AS responsible_name,
           (SELECT json_agg(a ORDER BY a.sort_order) FROM recovery_actions a WHERE a.recovery_plan_id=rp.id) AS actions
         FROM recovery_plans rp LEFT JOIN clients cl ON cl.id=rp.client_id LEFT JOIN users u ON u.id=rp.responsible_user_id
         WHERE rp.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/recovery-plans/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, final_result } = req.body || {};
      const { rows:[p] } = await db.query('SELECT * FROM recovery_plans WHERE id=$1', [id]);
      if (!p) return send404(reply);
      const { rows:[u] } = await db.query(`
        UPDATE recovery_plans SET status=$2::varchar,
          final_result=COALESCE($3,final_result),
          completed_at=CASE WHEN $2='completed' AND completed_at IS NULL THEN NOW() ELSE completed_at END,
          cancelled_at=CASE WHEN $2='cancelled' AND cancelled_at IS NULL THEN NOW() ELSE cancelled_at END,
          updated_at=NOW() WHERE id=$1 RETURNING *`,
        [id, newStatus, final_result||null]);
      return u;
    });

    v1.patch('/recovery-plans/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      const allowed = ['next_review_date','expected_result','responsible_user_id','target_health_score'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k));
      if (!fields.length) { const {rows:[p]}=await db.query('SELECT * FROM recovery_plans WHERE id=$1',[req.params.id]); return p||send404(reply); }
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      const { rows:[u] } = await db.query(`UPDATE recovery_plans SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, ...fields.map(([,v])=>v)]);
      if (!u) return send404(reply);
      return u;
    });

    // ── DASHBOARD ──────────────────────────────────────────
    v1.get('/dashboard/executive', { preHandler: [authenticate] }, async (_req, reply) => {
      try {
        const [summary, trend, area, clients, health] = await Promise.all([
          db.query(`SELECT
            COUNT(*) FILTER (WHERE status NOT IN ('closed'))::int AS open_tickets,
            COUNT(*) FILTER (WHERE sla_state='overdue' AND status NOT IN ('closed'))::int AS sla_overdue,
            COUNT(*) FILTER (WHERE sla_state='warn' AND status NOT IN ('closed'))::int AS sla_warn,
            COUNT(*) FILTER (WHERE criticality='critical' AND status NOT IN ('closed'))::int AS critical_tickets,
            COALESCE(SUM(revenue_at_risk) FILTER (WHERE status NOT IN ('closed')),0) AS total_revenue_at_risk,
            ROUND(AVG(EXTRACT(EPOCH FROM (NOW()-created_at))/86400) FILTER (WHERE status NOT IN ('closed')),1) AS avg_aging_days
            FROM tickets`),
          db.query(`SELECT TO_CHAR(DATE_TRUNC('month',created_at),'Mon/YY') AS month,
            DATE_TRUNC('month',created_at) AS month_date, COUNT(*)::int AS chamados,
            ROUND(100.0*COUNT(*) FILTER (WHERE sla_state NOT IN ('overdue'))/NULLIF(COUNT(*),0))::int AS sla_ok
            FROM tickets WHERE created_at >= NOW()-INTERVAL '6 months'
            GROUP BY DATE_TRUNC('month',created_at) ORDER BY month_date`),
          db.query(`SELECT area_responsible AS area, COUNT(*)::int AS ticket_count,
            COALESCE(SUM(revenue_at_risk),0) AS total_revenue_at_risk
            FROM tickets WHERE created_at>=NOW()-INTERVAL '90 days' GROUP BY area_responsible ORDER BY ticket_count DESC LIMIT 8`),
          db.query(`SELECT COUNT(*) FILTER (WHERE health_status IN ('at_risk','critical') AND is_active)::int AS clients_at_risk,
            COUNT(*) FILTER (WHERE health_status='critical' AND is_active)::int AS clients_critical,
            COUNT(*) FILTER (WHERE health_status='recovered' AND is_active)::int AS clients_recovered FROM clients`),
          db.query(`SELECT health_status, COUNT(*)::int AS count FROM clients WHERE is_active=TRUE GROUP BY health_status`),
        ]);
        const [openComp, openRet, openRma, csatRow] = await Promise.all([
          db.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','cancelled'))::int AS open_complaints,
            COUNT(*) FILTER (WHERE severity='critical' AND status NOT IN ('closed','cancelled'))::int AS critical_complaints FROM complaints`),
          db.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected'))::int AS open_returns FROM returns`),
          db.query(`SELECT COUNT(*) FILTER (WHERE status NOT IN ('closed','rejected'))::int AS open_rmas FROM rma`),
          db.query(`SELECT ROUND(AVG(score)::numeric,1) AS csat_avg FROM csat WHERE collection_date>=CURRENT_DATE-30`),
        ]);
        const clientRank = await db.query(`
          SELECT c.id,c.name,c.health_status,c.health_score,
            COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('closed'))::int AS open_tickets,
            COUNT(DISTINCT comp.id) FILTER (WHERE comp.status NOT IN ('closed','cancelled'))::int AS open_complaints
          FROM clients c LEFT JOIN tickets t ON t.client_id=c.id LEFT JOIN complaints comp ON comp.client_id=c.id
          WHERE c.is_active=TRUE GROUP BY c.id, c.name, c.health_status, c.health_score
          ORDER BY COUNT(DISTINCT t.id) FILTER (WHERE t.status NOT IN ('closed'))+COUNT(DISTINCT comp.id) FILTER (WHERE comp.status NOT IN ('closed','cancelled')) DESC LIMIT 8`);
        return {
          summary: { ...summary.rows[0], ...clients.rows[0], ...openComp.rows[0], ...openRet.rows[0], ...openRma.rows[0], csat_avg: csatRow.rows[0]?.csat_avg },
          trend: trend.rows,
          area_ranking: area.rows,
          client_ranking: clientRank.rows,
          health_distribution: health.rows,
        };
      } catch(e) { return reply.code(500).send({ error:'DASHBOARD_ERROR', message:e.message }); }
    });

    v1.get('/dashboard/control-tower', { preHandler: [authenticate] }, async (_req, reply) => {
      try {
        const [critical, overdue, noOwner, pendingApproval, critComp, blockedRet, stuckRma, noUpdate] = await Promise.all([
          db.query(`SELECT id,client_name,status,criticality,sla_state,description,revenue_at_risk,created_at FROM tickets WHERE criticality='critical' AND status NOT IN ('closed') ORDER BY created_at LIMIT 20`),
          db.query(`SELECT id,client_name,status,criticality,sla_state,description,sla_deadline FROM tickets WHERE sla_state='overdue' AND status NOT IN ('closed') ORDER BY sla_deadline LIMIT 20`),
          db.query(`SELECT id,client_name,status,description,created_at FROM tickets WHERE status='new' ORDER BY created_at LIMIT 20`),
          db.query(`SELECT id,client_name,status,approval_status,description,created_at FROM tickets WHERE status='resolved' AND approval_status='pending' ORDER BY created_at LIMIT 20`),
          db.query(`SELECT id,client_id,type_key,severity,status,reason AS description,loss_risk,created_at FROM complaints WHERE severity='critical' AND status NOT IN ('closed','cancelled') ORDER BY created_at LIMIT 10`),
          db.query(`SELECT id,client_id,status,reason,total_value,created_at FROM returns WHERE status IN ('awaiting_approval','awaiting_fiscal') ORDER BY created_at LIMIT 10`),
          db.query(`SELECT id,client_id,status,product_name,defect_description,created_at FROM rma WHERE status IN ('awaiting_decision','received') ORDER BY created_at LIMIT 10`),
          db.query(`SELECT t.id,t.client_name,t.status,t.updated_at,ROUND(EXTRACT(EPOCH FROM (NOW()-t.updated_at))/3600)::int AS hours_since_update FROM tickets t WHERE t.status NOT IN ('closed','resolved') AND t.updated_at<NOW()-INTERVAL '48 hours' ORDER BY t.updated_at LIMIT 10`),
        ]);
        return { critical_tickets:critical.rows, sla_overdue:overdue.rows, no_owner_tickets:noOwner.rows,
          pending_approval:pendingApproval.rows, critical_complaints:critComp.rows,
          blocked_returns:blockedRet.rows, stuck_rmas:stuckRma.rows, no_update_tickets:noUpdate.rows };
      } catch(e) { return reply.code(500).send({ error:'TOWER_ERROR', message:e.message }); }
    });

    v1.get('/dashboard/cs', { preHandler: [authenticate] }, async () => {
      const [atRisk, recentCsat, recovery] = await Promise.all([
        db.query(`SELECT c.*,(SELECT COUNT(*) FROM tickets t WHERE t.client_id=c.id AND t.status NOT IN ('closed'))::int AS open_tickets FROM clients c WHERE c.health_status IN ('at_risk','critical') AND c.is_active=TRUE ORDER BY c.health_score LIMIT 10`),
        db.query(`SELECT cs.*,cl.name AS client_name FROM csat cs LEFT JOIN clients cl ON cl.id=cs.client_id ORDER BY cs.collection_date DESC LIMIT 10`),
        db.query(`SELECT rp.*,cl.name AS client_name FROM recovery_plans rp LEFT JOIN clients cl ON cl.id=rp.client_id WHERE rp.status IN ('open','in_progress') ORDER BY rp.created_at DESC LIMIT 5`),
      ]);
      return { clients_at_risk:atRisk.rows, recent_csat:recentCsat.rows, active_recovery:recovery.rows };
    });

    v1.get('/dashboard/reports', { preHandler: [authenticate] }, async (req) => {
      const days = parseInt((req.query||{}).period||'30');
      const [byStatus,byArea,byType,retByStatus,csatByClient,revRisk,rmaByStatus] = await Promise.all([
        db.query(`SELECT status, COUNT(*)::int AS count FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`),
        db.query(`SELECT area_responsible AS area, COUNT(*)::int AS count, COALESCE(SUM(revenue_at_risk),0) AS revenue_at_risk FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY area_responsible ORDER BY count DESC`),
        db.query(`SELECT type_key AS type, COUNT(*)::int AS count FROM complaints WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY type_key ORDER BY count DESC`),
        db.query(`SELECT status, COUNT(*)::int AS count FROM returns WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`),
        db.query(`SELECT cl.name, ROUND(AVG(cs.score),1) AS csat_avg, COUNT(cs.id)::int AS responses FROM csat cs LEFT JOIN clients cl ON cl.id=cs.client_id WHERE cs.collection_date>=CURRENT_DATE-${days} GROUP BY cl.name ORDER BY csat_avg ASC LIMIT 10`),
        db.query(`SELECT cl.name, SUM(t.revenue_at_risk) AS total FROM tickets t LEFT JOIN clients cl ON cl.id=t.client_id WHERE t.revenue_at_risk>0 AND t.status NOT IN ('closed') GROUP BY cl.name ORDER BY total DESC LIMIT 8`),
        db.query(`SELECT status, COUNT(*)::int AS count FROM rma WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`),
      ]);
      return { period_days:days, tickets_by_status:byStatus.rows, tickets_by_area:byArea.rows,
        complaints_by_type:byType.rows, returns_by_status:retByStatus.rows,
        csat_by_client:csatByClient.rows, revenue_at_risk:revRisk.rows, rma_by_status:rmaByStatus.rows };
    });

  }, { prefix: '/api/v1' });

  // ── Error handlers ─────────────────────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error:'NOT_FOUND', message:'Rota não encontrada.', status:404 });
  });
  app.setErrorHandler((err, req, reply) => {
    req.log.error(err);
    if (err.validation) return reply.code(400).send({ error:'VALIDATION_ERROR', message:err.message, status:400 });
    reply.code(500).send({ error:'INTERNAL_ERROR', message:'Erro interno do servidor.', status:500 });
  });

  return app;
}

// ── Start server ────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
const host = process.env.HOST || '0.0.0.0';

buildApp().then(async (app) => {
  await app.listen({ port, host });
  console.log(`🚀 Nextra CSO Hub rodando em http://${host}:${port}`);
  console.log(`   /health  →  http://${host}:${port}/health\n`);
}).catch(err => {
  console.error('Falha ao iniciar:', err);
  process.exit(1);
});
