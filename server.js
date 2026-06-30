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
const crypto      = require('crypto');

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
const v_defined = (v) => v !== undefined && v !== null && v !== '';

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

  // Página pública de pesquisa CSAT/NPS (sem autenticação)
  app.get('/survey/:token', async (req, reply) => {
    return reply.type('text/html; charset=utf-8').send(`<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Pesquisa de Satisfação — Nextra</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;font-family:-apple-system,'Inter',sans-serif}
body{background:#1A1730;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.card{background:#fff;border-radius:16px;padding:32px;max-width:440px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.3)}
.logo{display:flex;align-items:center;gap:8px;margin-bottom:20px}
.dot{width:9px;height:9px;border-radius:50%;background:#6D40E6}
.logo span{font-weight:800;font-size:15px;color:#1A1730}
h1{font-size:20px;color:#1A1730;margin-bottom:6px}
p{color:#6B6990;font-size:14px;margin-bottom:24px}
.stars{display:flex;gap:8px;justify-content:center;margin-bottom:24px}
.star{font-size:36px;cursor:pointer;opacity:.25;transition:.15s}
.star.active{opacity:1}
.nps-row{display:flex;gap:4px;margin-bottom:24px;flex-wrap:wrap;justify-content:center}
.nps-btn{width:34px;height:34px;border-radius:8px;border:1px solid #E4E0F5;background:#fff;font-weight:700;cursor:pointer;font-size:13px}
.nps-btn.active{background:#6D40E6;color:#fff;border-color:#6D40E6}
textarea{width:100%;border:1px solid #E4E0F5;border-radius:8px;padding:10px;font-size:13px;min-height:70px;margin-bottom:16px;font-family:inherit}
button.submit{width:100%;padding:12px;background:#6D40E6;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:14px;cursor:pointer}
button.submit:disabled{opacity:.4;cursor:not-allowed}
.done{text-align:center;padding:20px 0}
.done .icon{font-size:48px;margin-bottom:12px}
.err{background:#FEF2F2;color:#991B1B;padding:12px;border-radius:8px;font-size:13px;margin-bottom:16px}
</style></head><body><div class="card" id="app">Carregando...</div>
<script>
const token = location.pathname.split('/').pop();
const app = document.getElementById('app');
let score = null;
async function load() {
  try {
    const r = await fetch('/api/v1/public/survey/'+token);
    const d = await r.json();
    if (!r.ok) { app.innerHTML = '<div class="err">'+(d.message||'Link inválido ou expirado.')+'</div>'; return; }
    render(d);
  } catch(e) { app.innerHTML = '<div class="err">Erro ao carregar pesquisa.</div>'; }
}
function render(d) {
  const isCsat = d.survey_type === 'csat';
  app.innerHTML = '<div class="logo"><div class="dot"></div><span>Nextra CSO Hub</span></div>'+
    '<h1>Olá, '+(d.client_name||'cliente')+'!</h1>'+
    '<p>'+(isCsat?'Como você avalia o atendimento que recebeu?':'De 0 a 10, o quanto você recomendaria a Nextra a um colega?')+'</p>'+
    (isCsat?'<div class="stars" id="stars">'+[1,2,3,4,5].map(n=>'<span class="star" data-v="'+n+'">★</span>').join('')+'</div>'
           :'<div class="nps-row" id="nps">'+Array.from({length:11},(_,n)=>'<button class="nps-btn" data-v="'+n+'">'+n+'</button>').join('')+'</div>')+
    '<textarea id="comment" placeholder="Comentário (opcional)"></textarea>'+
    '<button class="submit" id="send" disabled>Enviar resposta</button>';
  const picker = document.getElementById(isCsat?'stars':'nps');
  picker.addEventListener('click', e=>{
    const v = e.target.getAttribute('data-v'); if(v===null) return;
    score = parseInt(v);
    [...picker.children].forEach(c=>c.classList.toggle('active', parseInt(c.getAttribute('data-v'))<=score && isCsat || c===e.target && !isCsat));
    document.getElementById('send').disabled = false;
  });
  document.getElementById('send').onclick = submit;
}
async function submit() {
  const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    const r = await fetch('/api/v1/public/survey/'+token, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ score, comment: document.getElementById('comment').value }) });
    if (!r.ok) throw new Error('Falha ao enviar');
    app.innerHTML = '<div class="done"><div class="icon">✅</div><h1>Obrigado!</h1><p>Sua resposta foi registrada com sucesso.</p></div>';
  } catch(e) { btn.disabled = false; btn.textContent = 'Tentar novamente'; }
}
load();
</script></body></html>`);
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
      const { rows } = await db.query('SELECT * FROM complaint_type_config ORDER BY sort_order, label_pt').catch(() => ({ rows: [] }));
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

    // Lightweight lookup for dropdowns (AM, BDM, responsável) — any authenticated user
    v1.get('/users/lookup', { preHandler: [authenticate] }, async (req) => {
      const { role } = req.query || {};
      const where = ['is_active=TRUE']; const params = [];
      if (role) { params.push(role); where.push(`role=$${params.length}`); }
      const { rows } = await db.query(`SELECT id,name,role,title FROM users WHERE ${where.join(' AND ')} ORDER BY name`, params);
      return rows;
    });

    v1.get('/users', { preHandler: [authorize('admin')] }, async (req) => {
      const { rows } = await db.query('SELECT id,name,email,login,role,title,access_level,department,phone,is_active,last_login_at,created_at FROM users ORDER BY name');
      return rows;
    });

    v1.post('/users', { preHandler: [authorize('admin')] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.name || !d.login || !d.password || !d.role)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'name, login, password e role obrigatórios.', status:400 });
      const { rows: dup } = await db.query('SELECT id FROM users WHERE login=$1', [d.login]);
      if (dup.length) return reply.code(409).send({ error:'LOGIN_TAKEN', message:'Login já em uso.', status:409 });
      const hash = await bcrypt.hash(String(d.password), 10);
      const { rows:[u] } = await db.query(`
        INSERT INTO users (name,email,login,password_hash,role,title,access_level,department,phone,is_active)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE)
        RETURNING id,name,email,login,role,title,access_level,department,phone,is_active,created_at`,
        [d.name, d.email||null, d.login, hash, d.role, d.title||null, d.access_level||'standard', d.department||null, d.phone||null]);
      return reply.code(201).send(u);
    });

    v1.patch('/users/:id', { preHandler: [authorize('admin')] }, async (req, reply) => {
      const d = req.body || {};
      const allowed = ['name','email','title','role','access_level','department','phone','is_active'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k));
      if (!fields.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nenhum campo válido.', status:400 });
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      const { rows:[u] } = await db.query(
        `UPDATE users SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING id,name,email,login,role,title,access_level,department,phone,is_active`,
        [req.params.id, ...fields.map(([,v])=>v)]);
      if (!u) return send404(reply);
      return u;
    });

    v1.patch('/users/:id/password', { preHandler: [authorize('admin')] }, async (req, reply) => {
      const { password } = req.body || {};
      if (!password || password.length < 6) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Senha mínima de 6 caracteres.', status:400 });
      const hash = await bcrypt.hash(String(password), 10);
      const { rows:[u] } = await db.query('UPDATE users SET password_hash=$2, updated_at=NOW() WHERE id=$1 RETURNING id,name,login', [req.params.id, hash]);
      if (!u) return send404(reply);
      return { message:'Senha redefinida com sucesso.', user:u };
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
        `SELECT t.*, am.name AS am_name, bdm.name AS bdm_name FROM tickets t
         LEFT JOIN users am ON am.id=t.am_user_id LEFT JOIN users bdm ON bdm.id=t.bdm_user_id
         WHERE ${where.join(' AND ')} ORDER BY
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
      const notifyAreas = Array.isArray(d.notify_areas) ? d.notify_areas : (typeof d.notify_areas==='string' && d.notify_areas ? d.notify_areas.split(',').filter(Boolean) : []);
      try {
        const { rows:[ticket] } = await db.query(`
          INSERT INTO tickets (id, business_unit_id, client_id, client_name, client_cnpj, created_by_user_id,
            am_user_id, bdm_user_id, channel, occurrence_type, criticality, area_responsible, notify_areas,
            description, expectation, previous_action,
            order_number, nf_number, order_value, revenue_at_risk,
            product_name_snap, serial_number_snap,
            is_vip, is_recurrence,
            sla_deadline, sla_state, status, approval_status, reopen_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::user_role[],$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,'ok','new','pending',0)
          RETURNING *`,
          [ticketId, d.business_unit_id||'led', d.client_id||null, d.client_name, d.cnpj||null, user.sub,
           d.am_user_id||null, d.bdm_user_id||null,
           d.channel||'whatsapp', d.occurrence_type||'technical_support',
           d.criticality||'medium', d.area_responsible||'support', notifyAreas,
           d.description, d.expectation||null, d.previous_action||null,
           d.order_number||null, d.nf_number||null, d.order_value||null, d.revenue_at_risk||0,
           d.product||null, d.serial_number||null,
           d.is_vip||false, d.is_recurrence||false, slaDeadline.toISOString()]
        );
        await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action) VALUES ($1,$2,'ticket_aberto')`, [ticketId, user.sub]);
        return reply.code(201).send(ticket);
      } catch(e) {
        return reply.code(400).send({ error:'CREATE_FAILED', message: e.message, status:400 });
      }
    });

    v1.get('/tickets/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(`
        SELECT t.*, am.name AS am_name, bdm.name AS bdm_name, resp.name AS resp_name
        FROM tickets t
        LEFT JOIN users am   ON am.id=t.am_user_id
        LEFT JOIN users bdm  ON bdm.id=t.bdm_user_id
        LEFT JOIN users resp ON resp.id=t.resp_user_id
        WHERE t.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/tickets/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const d = req.body || {};
      const allowed = ['root_cause_category','root_cause_description','resolution','preventive_action',
        'area_responsible','resp_user_id','am_user_id','bdm_user_id','manager_user_id',
        'revenue_at_risk','order_number','order_value','nf_number',
        'client_cnpj','expectation','previous_action','product_name_snap','serial_number_snap'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) return t;
      const set = fields.map(([k],i)=>`${k}=$${i+2}${k==='area_responsible'?'::user_role':''}`).join(', ');
      try {
        const { rows:[u] } = await db.query(
          `UPDATE tickets SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING *`,
          [id, ...fields.map(([,v])=>v)]
        );
        return u;
      } catch(e) {
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.patch('/tickets/:id/notify-areas', { preHandler: [authenticate] }, async (req, reply) => {
      const areas = Array.isArray(req.body?.notify_areas) ? req.body.notify_areas : [];
      const { rows:[u] } = await db.query(`UPDATE tickets SET notify_areas=$2::user_role[], updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id, areas]);
      if (!u) return send404(reply);
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
    // Fluxo: open(ouvida) → in_progress(tratada) → awaiting_client → resolved(resolvida) → closed(sanada)
    v1.get('/complaints', { preHandler: [authenticate] }, async (req) => {
      const { status, severity, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)   { params.push(status);   where.push(`c.status=$${params.length}`); }
      if (severity) { params.push(severity); where.push(`c.severity=$${params.length}`); }
      if (client_id){ params.push(parseInt(client_id)); where.push(`c.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT c.*, cl.name AS client_name, ru.name AS responsible_name FROM complaints c
         LEFT JOIN clients cl ON cl.id=c.client_id
         LEFT JOIN users ru ON ru.id=c.responsible_user_id
         WHERE ${where.join(' AND ')} ORDER BY c.created_at DESC`, params);
      return { data: rows };
    });

    v1.post('/complaints', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.reason) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e reason obrigatórios.', status:400 });
      const user = getUser(req);
      try {
        const { rows:[c] } = await db.query(`
          INSERT INTO complaints (client_id, business_unit_id, type_key, severity, procedence,
            reason, client_feeling, causing_area, responsible_area, responsible_user_id,
            loss_risk, commercial_impact, ticket_id, channel, created_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8::user_role,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [d.client_id, d.business_unit_id||'led', d.type_key||'other', d.severity||'medium',
           d.procedence||'under_analysis', d.reason, d.client_feeling||null, d.causing_area||null,
           d.responsible_area||'cso', d.responsible_user_id||null,
           d.loss_risk||0, d.commercial_impact||null, d.ticket_id||null, d.channel||null, user.sub]);
        await db.query(`INSERT INTO complaint_history (complaint_id,user_id,action,new_status) VALUES ($1,$2,'reclamação registrada (ouvida)','open')`,
          [c.id, user.sub]);
        return reply.code(201).send(c);
      } catch(e) {
        return reply.code(400).send({ error:'CREATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.get('/complaints/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT c.*, cl.name AS client_name, ru.name AS responsible_name,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT ch.*, u.name AS user_name FROM complaint_history ch
             LEFT JOIN users u ON u.id=ch.user_id WHERE ch.complaint_id=c.id) h) AS history
         FROM complaints c LEFT JOIN clients cl ON cl.id=c.client_id
         LEFT JOIN users ru ON ru.id=c.responsible_user_id
         WHERE c.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/complaints/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows:[c] } = await db.query('SELECT * FROM complaints WHERE id=$1', [req.params.id]);
      if (!c) return send404(reply);
      const d = req.body || {};
      const allowed = ['recovery_action','resolution','loss_risk','responsible_area','responsible_user_id',
        'procedence','client_feeling','causing_area','commercial_impact','type_key','severity','channel'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) return c;
      const castMap = { causing_area:'::user_role', responsible_area:'::user_role' };
      const set = fields.map(([k],i)=>`${k}=$${i+2}${castMap[k]||''}`).join(', ');
      try {
        const { rows:[u] } = await db.query(`UPDATE complaints SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, ...fields.map(([,v])=>v)]);
        // log significant identification fields
        if (d.causing_area || d.recovery_action) {
          await db.query(`INSERT INTO complaint_history (complaint_id,user_id,action,note) VALUES ($1,$2,'causa identificada / ação de recuperação registrada',$3)`,
            [req.params.id, getUser(req).sub, d.recovery_action||d.causing_area||null]);
        }
        return u;
      } catch(e) {
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.patch('/complaints/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note } = req.body || {};
      const { rows:[c] } = await db.query('SELECT * FROM complaints WHERE id=$1', [id]);
      if (!c) return send404(reply);
      // valida transição usando a função do banco
      const { rows:[vt] } = await db.query('SELECT validate_complaint_transition($1::complaint_status,$2::complaint_status) AS valid', [c.status, newStatus]);
      if (!vt.valid) return reply.code(422).send({ error:'INVALID_STATUS_TRANSITION', message:`Transição de '${c.status}' para '${newStatus}' não é permitida.`, status:422 });
      if (newStatus === 'resolved' && !c.recovery_action && !c.resolution)
        return send422(reply, 'Registre a ação de recuperação ou a resolução antes de marcar como resolvida.', 'MISSING_RESOLUTION');
      const STAGE_LABEL = { open:'ouvida', in_progress:'tratada', awaiting_client:'aguardando cliente', resolved:'resolvida', closed:'sanada', cancelled:'cancelada' };
      const { rows:[u] } = await db.query(`
        UPDATE complaints SET status=$2::complaint_status, updated_at=NOW() WHERE id=$1 RETURNING *`, [id, newStatus]);
      await db.query(`INSERT INTO complaint_history (complaint_id,user_id,action,old_status,new_status,note) VALUES ($1,$2,$3,$4,$5,$6)`,
        [id, getUser(req).sub, `status: ${STAGE_LABEL[c.status]||c.status} → ${STAGE_LABEL[newStatus]||newStatus}`, c.status, newStatus, note||null]);
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
    // Fluxo real (return_status enum): return_requested → under_review → awaiting_approval →
    //   approved → awaiting_customer_shipment → in_transit → received → under_inspection →
    //   awaiting_fiscal → awaiting_credit → refund_or_credit_issued → closed
    //   (ou rejected a qualquer momento permitido)
    v1.get('/returns', { preHandler: [authenticate] }, async (req) => {
      const { status, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)    { params.push(status);           where.push(`r.status=$${params.length}`); }
      if (client_id) { params.push(parseInt(client_id)); where.push(`r.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,
           (r.tax_cost+r.freight_cost+r.refaturamento_cost+r.difal_cost+r.warehouse_overhead_cost) AS total_cost_generated
         FROM returns r
         LEFT JOIN clients cl ON cl.id=r.client_id WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params);
      return { data: rows };
    });

    v1.post('/returns', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.reason) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e reason obrigatórios.', status:400 });
      try {
        const { rows:[r] } = await db.query(`
          INSERT INTO returns (client_id,business_unit_id,reason,quantity,product_name_snap,
            unit_value,order_number,nf_number,nf_value,nf_attached,ticket_id,responsible_user_id,status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'return_requested') RETURNING *`,
          [d.client_id,d.business_unit_id||'led',d.reason,d.quantity||1,
           d.product_name||null,d.unit_value||null,
           d.order_number||null,d.nf_number||null,d.nf_value||null,d.nf_attached||false,
           d.ticket_id||null, d.responsible_user_id||getUser(req).sub]);
        await db.query(`INSERT INTO return_history (return_id,user_id,action) VALUES ($1,$2,'devolução registrada')`,
          [r.id, getUser(req).sub]);
        return reply.code(201).send(r);
      } catch(e) {
        return reply.code(400).send({ error:'CREATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.get('/returns/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,
           (r.tax_cost+r.freight_cost+r.refaturamento_cost+r.difal_cost+r.warehouse_overhead_cost) AS total_cost_generated,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT rh.*,u.name AS user_name FROM return_history rh
             LEFT JOIN users u ON u.id=rh.user_id WHERE rh.return_id=r.id) h) AS history
         FROM returns r LEFT JOIN clients cl ON cl.id=r.client_id WHERE r.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      return rows[0];
    });

    v1.patch('/returns/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows:[r] } = await db.query('SELECT * FROM returns WHERE id=$1', [req.params.id]);
      if (!r) return send404(reply);
      const d = req.body || {};
      const allowed = ['nf_number','nf_value','nf_attached','root_cause','root_cause_notes',
        'reduction_action','reduction_feasible','tax_cost','freight_cost','refaturamento_cost',
        'difal_cost','cost_status','decision_notes'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) return r;
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      try {
        const { rows:[u] } = await db.query(`UPDATE returns SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, ...fields.map(([,v])=>v)]);
        await db.query(`INSERT INTO return_history (return_id,user_id,action,note) VALUES ($1,$2,'análise de causa / custo atualizada',$3)`,
          [req.params.id, getUser(req).sub, d.root_cause_notes||d.reduction_action||null]);
        return u;
      } catch(e) {
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.patch('/returns/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note, reject_reason, decision } = req.body || {};
      const { rows:[r] } = await db.query('SELECT * FROM returns WHERE id=$1', [id]);
      if (!r) return send404(reply);
      const { rows:[vt] } = await db.query('SELECT validate_return_transition($1::return_status,$2::return_status) AS valid', [r.status, newStatus]);
      if (!vt.valid) return reply.code(422).send({ error:'INVALID_STATUS_TRANSITION', message:`Transição de '${r.status}' para '${newStatus}' não é permitida.`, status:422 });
      if (newStatus === 'rejected' && !reject_reason)
        return send422(reply, 'Motivo da rejeição obrigatório.', 'REJECT_REASON_REQUIRED');
      if (newStatus === 'approved' && !decision)
        return send422(reply, 'Decisão obrigatória para aprovar (credit/swap/replacement/refund/discount).', 'DECISION_REQUIRED');
      try {
        const { rows:[u] } = await db.query(`
          UPDATE returns SET status=$2::return_status,
            reject_reason=COALESCE($3,reject_reason),
            decision=COALESCE($4::return_decision,decision),
            updated_at=NOW() WHERE id=$1 RETURNING *`,
          [id, newStatus, reject_reason||null, decision||null]);
        await db.query(`INSERT INTO return_history (return_id,user_id,action,old_status,new_status,note) VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, getUser(req).sub, `status: ${r.status} → ${newStatus}`, r.status, newStatus, note||null]);
        return u;
      } catch(e) {
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      }
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

    v1.get('/returns/reports/savings', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query('SELECT * FROM view_returns_savings');
      return { data: rows };
    });

    // ── SUPPLIERS (usado pelo módulo RMA) ───────────────────
    v1.get('/suppliers', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query('SELECT * FROM suppliers WHERE is_active=TRUE ORDER BY name');
      return { data: rows };
    });

    v1.post('/suppliers', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.name) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'name obrigatório.', status:400 });
      const { rows:[s] } = await db.query(
        `INSERT INTO suppliers (name,cnpj,contact,phone,email) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
        [d.name, d.cnpj||null, d.contact||null, d.phone||null, d.email||null]);
      return reply.code(201).send(s);
    });

    // ── RMA ────────────────────────────────────────────────
    v1.get('/rma', { preHandler: [authenticate] }, async (req) => {
      const { status, client_id } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)    { params.push(status);           where.push(`r.status=$${params.length}`); }
      if (client_id) { params.push(parseInt(client_id)); where.push(`r.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,sp.name AS supplier_name,
           (SELECT COUNT(*)::int FROM rma r2 WHERE COALESCE(r2.product_code,r2.product_name)=COALESCE(r.product_code,r.product_name) AND r2.id!=r.id) AS recurrence_count
         FROM rma r
         LEFT JOIN clients cl ON cl.id=r.client_id
         LEFT JOIN suppliers sp ON sp.id=r.supplier_id
         WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params);
      return { data: rows.map(r => ({ ...r, is_recurrence: r.recurrence_count > 0 })) };
    });

    v1.post('/rma', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.product_name || !d.defect_description) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'product_name e defect_description obrigatórios.', status:400 });
      const user = getUser(req);
      try {
        const { rows:[r] } = await db.query(`
          INSERT INTO rma (client_id,business_unit_id,ticket_id,product_name,product_code,
            serial_number,defect_description,warranty,unit_cost,supplier_id,responsible_user_id,created_by_user_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
          [d.client_id||null,d.business_unit_id||'led',d.ticket_id||null,d.product_name,
           d.product_code||null,d.serial_number||null,d.defect_description,
           d.warranty||false,d.unit_cost||null,d.supplier_id||null,d.responsible_user_id||user.sub,user.sub]);
        await db.query(`INSERT INTO rma_history (rma_id,user_id,action,new_status) VALUES ($1,$2,'rma_criado','requested')`,
          [r.id, user.sub]);
        // Detecta recorrência automaticamente
        const { rows: rec } = await db.query(
          `SELECT COUNT(*)::int AS cnt FROM rma WHERE COALESCE(product_code,product_name)=COALESCE($1,$2) AND id != $3`,
          [d.product_code||null, d.product_name, r.id]);
        return reply.code(201).send({ ...r, is_recurrence: rec[0].cnt > 0, recurrence_count: rec[0].cnt });
      } catch(e) {
        return reply.code(400).send({ error:'CREATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.get('/rma/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows } = await db.query(
        `SELECT r.*,cl.name AS client_name,sp.name AS supplier_name,
           (SELECT json_agg(h ORDER BY h.created_at DESC) FROM (
             SELECT rh.*,u.name AS user_name FROM rma_history rh
             LEFT JOIN users u ON u.id=rh.user_id WHERE rh.rma_id=r.id) h) AS history
         FROM rma r LEFT JOIN clients cl ON cl.id=r.client_id LEFT JOIN suppliers sp ON sp.id=r.supplier_id WHERE r.id=$1`, [req.params.id]);
      if (!rows.length) return send404(reply);
      const rma = rows[0];
      const { rows: rec } = await db.query(
        `SELECT id,status,created_at FROM rma WHERE COALESCE(product_code,product_name)=COALESCE($1,$2) AND id != $3 ORDER BY created_at DESC`,
        [rma.product_code, rma.product_name, rma.id]);
      rma.related_recurrences = rec;
      return rma;
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
      const d = req.body || {};
      const allowed = ['technical_notes','decision_notes','outcome_type','unit_cost',
        'rebate_applicable','rebate_value','rebate_status','supplier_id'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) { const {rows:[r]}=await db.query('SELECT * FROM rma WHERE id=$1',[req.params.id]); return r||send404(reply); }
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      try {
        const { rows:[u] } = await db.query(`UPDATE rma SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, ...fields.map(([,v])=>v)]);
        if (!u) return send404(reply);
        if (d.outcome_type) {
          await db.query(`INSERT INTO rma_history (rma_id,user_id,action,note) VALUES ($1,$2,'desfecho registrado',$3)`,
            [req.params.id, getUser(req).sub, d.outcome_type]);
        }
        return u;
      } catch(e) {
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      }
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

    v1.get('/rma/reports/recurrence', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query('SELECT * FROM view_rma_recurrence LIMIT 30');
      return { data: rows };
    });

    v1.get('/rma/reports/financial', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query('SELECT * FROM view_rma_financial');
      return { data: rows };
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
      const { rows:[client] } = await db.query(`
        SELECT c.*, am.name AS am_name, bdm.name AS bdm_name
        FROM clients c LEFT JOIN users am ON am.id=c.account_manager_id LEFT JOIN users bdm ON bdm.id=c.bdm_id
        WHERE c.id=$1`, [id]);
      if (!client) return send404(reply);
      const [tickets,complaints,returns,rmas,csat_d,nps_d,recovery,hlog] = await Promise.all([
        db.query(`SELECT t.id,t.status,t.criticality,t.sla_state,t.description,t.revenue_at_risk,t.occurrence_type,t.created_at,t.resolved_at,
          am.name AS am_name, bdm.name AS bdm_name FROM tickets t
          LEFT JOIN users am ON am.id=t.am_user_id LEFT JOIN users bdm ON bdm.id=t.bdm_user_id
          WHERE t.client_id=$1 ORDER BY t.created_at DESC LIMIT 20`,[id]),
        db.query('SELECT id,type_key,severity,status,reason,loss_risk,causing_area,created_at FROM complaints WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT id,status,reason,total_value,decision,root_cause,(tax_cost+freight_cost+refaturamento_cost+difal_cost+warehouse_overhead_cost) AS total_cost,created_at FROM returns WHERE client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT id,status,product_name,defect_description,warranty,rma_decision_v1 AS decision,outcome_type,created_at FROM rma r WHERE r.client_id=$1 ORDER BY created_at DESC LIMIT 10',[id]),
        db.query('SELECT score,comment,collection_date FROM csat WHERE client_id=$1 ORDER BY collection_date DESC LIMIT 10',[id]),
        db.query('SELECT score,nps_type,comment,collection_date FROM nps WHERE client_id=$1 ORDER BY collection_date DESC LIMIT 5',[id]),
        db.query("SELECT id,status,reason,health_score_at_open,target_health_score,next_review_date FROM recovery_plans WHERE client_id=$1 ORDER BY created_at DESC LIMIT 5",[id]),
        db.query('SELECT health_score,health_status,reason,delta,recorded_at AS changed_at FROM client_health_log WHERE client_id=$1 ORDER BY recorded_at DESC LIMIT 20',[id]),
      ]);
      const open = tickets.rows.filter(t=>t.status!=='closed');
      const csatAvg = csat_d.rows.length ? (csat_d.rows.reduce((s,c)=>s+c.score,0)/csat_d.rows.length).toFixed(1) : null;
      const promoters = nps_d.rows.filter(n=>n.nps_type==='promoter').length;
      const detractors = nps_d.rows.filter(n=>n.nps_type==='detractor').length;
      const npsScore = nps_d.rows.length ? Math.round(((promoters-detractors)/nps_d.rows.length)*100) : null;
      const totalReturnsCost = returns.rows.reduce((s,r)=>s+(parseFloat(r.total_cost)||0),0);
      return { client, summary: {
        open_tickets: open.length,
        open_complaints: complaints.rows.filter(c=>!['closed','cancelled'].includes(c.status)).length,
        open_returns: returns.rows.filter(r=>!['closed','rejected'].includes(r.status)).length,
        open_rmas: rmas.rows.filter(r=>!['closed','rejected'].includes(r.status)).length,
        total_revenue_at_risk: open.reduce((s,t)=>s+(t.revenue_at_risk||0),0),
        total_returns_cost: totalReturnsCost,
        csat_avg: csatAvg,
        nps_score: npsScore,
      }, tickets:tickets.rows, complaints:complaints.rows, returns:returns.rows, rmas:rmas.rows,
         csat:csat_d.rows, nps:nps_d.rows, recovery_plans:recovery.rows, health_log:hlog.rows };
    });

    // Breakdown explicativo do health score (espelha a lógica de recalc_client_health)
    v1.get('/clients/:id/health-factors', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { rows:[cl] } = await db.query('SELECT * FROM clients WHERE id=$1', [id]);
      if (!cl) return send404(reply);
      const [comp, csatPen, sla, recur, ret, rev] = await Promise.all([
        db.query("SELECT COALESCE(SUM(CASE severity WHEN 'critical' THEN 15 WHEN 'high' THEN 8 WHEN 'medium' THEN 4 ELSE 2 END),0)::int AS p FROM complaints WHERE client_id=$1 AND status NOT IN ('closed','cancelled','resolved')",[id]),
        db.query("SELECT COALESCE(SUM(CASE WHEN csat_score<3 THEN 10 WHEN csat_score<4 THEN 5 ELSE 0 END),0)::int AS p FROM complaints WHERE client_id=$1 AND csat_score IS NOT NULL AND csat_collected_at>=NOW()-INTERVAL '180 days'",[id]),
        db.query("SELECT COALESCE(COUNT(*)*5,0)::int AS p FROM tickets WHERE client_id=$1 AND status NOT IN ('closed','resolved') AND NOW()>sla_deadline AND NOT sla_paused",[id]),
        db.query("SELECT COALESCE(COUNT(*)*8,0)::int AS p FROM tickets WHERE client_id=$1 AND is_recurrence=TRUE AND status NOT IN ('closed','resolved')",[id]),
        db.query("SELECT COALESCE(SUM(CASE WHEN status='rejected' AND (closed_at IS NULL OR closed_at>=NOW()-INTERVAL '180 days') THEN 10 WHEN status NOT IN ('closed','rejected','refund_or_credit_issued') THEN 5 ELSE 0 END),0)::int AS p FROM returns WHERE client_id=$1",[id]),
        db.query("SELECT COALESCE(SUM(CASE WHEN revenue_at_risk>50000 THEN 10 ELSE 0 END),0)::int AS p FROM tickets WHERE client_id=$1 AND status NOT IN ('closed','resolved')",[id]),
      ]);
      const factors = [
        { label:'Reclamações ativas', penalty: comp.rows[0].p, icon:'⚠️' },
        { label:'CSAT baixo (180d)', penalty: csatPen.rows[0].p, icon:'⭐' },
        { label:'SLA vencido', penalty: sla.rows[0].p, icon:'⏰' },
        { label:'Recorrência de chamados', penalty: recur.rows[0].p, icon:'↩' },
        { label:'Devoluções (ativas/rejeitadas)', penalty: ret.rows[0].p, icon:'📦' },
        { label:'Receita em risco elevada', penalty: rev.rows[0].p, icon:'💰' },
      ].filter(f=>f.penalty>0);
      return { health_score: cl.health_score, health_status: cl.health_status, factors,
        total_penalty: factors.reduce((s,f)=>s+f.penalty,0) };
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

    // ── SURVEY LINKS (disparo de pesquisa CSAT/NPS) ─────────
    v1.post('/survey-links', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.survey_type || !['csat','nps'].includes(d.survey_type))
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e survey_type (csat|nps) obrigatórios.', status:400 });
      const token = crypto.randomBytes(20).toString('hex');
      const { rows:[link] } = await db.query(`
        INSERT INTO survey_links (token,survey_type,client_id,business_unit_id,ticket_id,complaint_id,created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
        [token, d.survey_type, d.client_id, d.business_unit_id||'led', d.ticket_id||null, d.complaint_id||null, getUser(req).sub]);
      const base = (process.env.PUBLIC_BASE_URL||'').replace(/\/$/,'');
      return reply.code(201).send({ ...link, survey_url: `${base}/survey/${token}` });
    });

    v1.get('/survey-links', { preHandler: [authenticate] }, async (req) => {
      const { client_id } = req.query || {};
      const where=['1=1']; const params=[];
      if (client_id) { params.push(parseInt(client_id)); where.push(`sl.client_id=$${params.length}`); }
      const { rows } = await db.query(
        `SELECT sl.*, cl.name AS client_name FROM survey_links sl
         LEFT JOIN clients cl ON cl.id=sl.client_id WHERE ${where.join(' AND ')} ORDER BY sl.created_at DESC LIMIT 50`, params);
      return { data: rows };
    });

    // Rota pública (sem auth) — usada pela página de resposta do cliente
    v1.get('/public/survey/:token', async (req, reply) => {
      const { rows:[link] } = await db.query(
        `SELECT sl.*, cl.name AS client_name FROM survey_links sl LEFT JOIN clients cl ON cl.id=sl.client_id WHERE sl.token=$1`,
        [req.params.token]);
      if (!link) return send404(reply);
      if (link.responded) return reply.code(410).send({ error:'ALREADY_RESPONDED', message:'Esta pesquisa já foi respondida.', status:410 });
      if (new Date(link.expires_at) < new Date()) return reply.code(410).send({ error:'EXPIRED', message:'Link de pesquisa expirado.', status:410 });
      return { survey_type: link.survey_type, client_name: link.client_name };
    });

    v1.post('/public/survey/:token', async (req, reply) => {
      const { rows:[link] } = await db.query('SELECT * FROM survey_links WHERE token=$1', [req.params.token]);
      if (!link) return send404(reply);
      if (link.responded) return reply.code(410).send({ error:'ALREADY_RESPONDED', status:410 });
      const { score, comment } = req.body || {};
      if (score===undefined) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'score obrigatório.', status:400 });
      try {
        if (link.survey_type === 'csat') {
          await db.query(`INSERT INTO csat (client_id,business_unit_id,ticket_id,complaint_id,score,comment,collection_date) VALUES ($1,$2,$3,$4,$5,$6,CURRENT_DATE)`,
            [link.client_id, link.business_unit_id, link.ticket_id, link.complaint_id, score, comment||null]);
        } else {
          await db.query(`INSERT INTO nps (client_id,business_unit_id,score,comment,collection_date) VALUES ($1,$2,$3,$4,CURRENT_DATE)`,
            [link.client_id, link.business_unit_id, score, comment||null]);
        }
        await db.query('UPDATE survey_links SET responded=TRUE, responded_at=NOW() WHERE id=$1', [link.id]);
        return reply.code(201).send({ message:'Obrigado pela sua resposta!' });
      } catch(e) {
        return reply.code(400).send({ error:'SUBMIT_FAILED', message:e.message, status:400 });
      }
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
      const allowed = ['next_review_date','expected_result','responsible_user_id','target_health_score','client_communication','leadership_notes'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) { const {rows:[p]}=await db.query('SELECT * FROM recovery_plans WHERE id=$1',[req.params.id]); return p||send404(reply); }
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      const { rows:[u] } = await db.query(`UPDATE recovery_plans SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, ...fields.map(([,v])=>v)]);
      if (!u) return send404(reply);
      return u;
    });

    v1.post('/recovery-plans', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_id || !d.reason) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id e reason obrigatórios.', status:400 });
      const user = getUser(req);
      const { rows:[cl] } = await db.query('SELECT health_score FROM clients WHERE id=$1', [d.client_id]);
      const { rows:[p] } = await db.query(`
        INSERT INTO recovery_plans (client_id, business_unit_id, status, reason, action,
          responsible_user_id, expected_result, health_score_at_open, target_health_score,
          next_review_date, created_by_user_id)
        VALUES ($1,$2,'open',$3,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [d.client_id, d.business_unit_id||'led', d.reason, d.responsible_user_id||null,
         d.expected_result||null, cl?.health_score||null, d.target_health_score||70,
         d.next_review_date||null, user.sub]);
      return reply.code(201).send(p);
    });

    // ── RECOVERY ACTIONS (plano de ação) ────────────────────
    v1.post('/recovery-plans/:id/actions', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.description) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'description obrigatória.', status:400 });
      const { rows:[a] } = await db.query(`
        INSERT INTO recovery_actions (recovery_plan_id,description,responsible,due_date,sort_order)
        VALUES ($1,$2,$3,$4,(SELECT COALESCE(MAX(sort_order),0)+1 FROM recovery_actions WHERE recovery_plan_id=$1))
        RETURNING *`, [req.params.id, d.description, d.responsible||null, d.due_date||null]);
      return reply.code(201).send(a);
    });

    v1.patch('/recovery-plans/:id/actions/:actionId', { preHandler: [authenticate] }, async (req, reply) => {
      const { status, notes } = req.body || {};
      const { rows:[a] } = await db.query(`
        UPDATE recovery_actions SET
          status=COALESCE($3::action_status,status),
          notes=COALESCE($4,notes),
          completed_at=CASE WHEN $3='done' THEN NOW() ELSE completed_at END
        WHERE id=$2 AND recovery_plan_id=$1 RETURNING *`,
        [req.params.id, req.params.actionId, status||null, notes||null]);
      if (!a) return send404(reply);
      return a;
    });

    // ── AI: sugestão de plano de recuperação ────────────────
    v1.post('/ai/recovery-plan', { preHandler: [authenticate] }, async (req, reply) => {
      const { client_id } = req.body || {};
      if (!client_id) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id obrigatório.', status:400 });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) return reply.code(503).send({ error:'AI_UNAVAILABLE', message:'Configure ANTHROPIC_API_KEY nas variáveis do Railway.' });
      const { rows:[cl] } = await db.query('SELECT * FROM clients WHERE id=$1', [client_id]);
      if (!cl) return send404(reply);
      const [tk, cp, rt] = await Promise.all([
        db.query(`SELECT description,criticality,status,created_at FROM tickets WHERE client_id=$1 AND status NOT IN ('closed') ORDER BY created_at DESC LIMIT 5`,[client_id]),
        db.query(`SELECT reason,severity,status FROM complaints WHERE client_id=$1 ORDER BY created_at DESC LIMIT 5`,[client_id]),
        db.query(`SELECT reason,status FROM returns WHERE client_id=$1 ORDER BY created_at DESC LIMIT 5`,[client_id]),
      ]);
      const prompt = `Você é um gestor comercial sênior do Grupo Nextra (distribuidora B2B de LED/PRO AV, segurança eletrônica, áudio e vídeo, cabeamento).

Cliente: ${cl.name} | Health Score atual: ${cl.health_score}/100 (${cl.health_status}) | Segmento: ${cl.segment||'não informado'}

Chamados ativos recentes: ${JSON.stringify(tk.rows)}
Reclamações recentes: ${JSON.stringify(cp.rows)}
Devoluções recentes: ${JSON.stringify(rt.rows)}

Monte um plano de recuperação de relacionamento para este cliente. Responda APENAS com JSON válido, sem markdown:
{"diagnosis":"diagnóstico em 1-2 frases sobre a causa raiz do risco","target_score":número de 60 a 90,"actions":[{"description":"ação objetiva e específica","responsible":"papel sugerido: AM, BDM, CSO, Suporte, Diretoria","due_in_days":número},...3 a 5 ações],"commercial_talking_points":"pontos-chave para o gestor comercial usar na conversa com o cliente, 2-3 frases"}`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:1000, messages:[{role:'user',content:prompt}] })
        });
        const d = await r.json();
        if (!r.ok) return reply.code(502).send({ error:'AI_ERROR', message:d.error?.message||'Erro na API de IA.' });
        const txt = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').replace(/```json|```/g,'').trim();
        return { success:true, result: JSON.parse(txt) };
      } catch(e) {
        return reply.code(502).send({ error:'AI_PARSE_ERROR', message:e.message });
      }
    });

    // ── AI TRIAGE ─────────────────────────────────────────
    v1.post('/ai/triage', { preHandler: [authenticate] }, async (req, reply) => {
      const { client_name, business_unit_id, product, description, expectation, previous_action } = req.body || {};
      if (!description || description.length < 10)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Descrição obrigatória (mín. 10 chars).' });
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey)
        return reply.code(503).send({ error:'AI_UNAVAILABLE', message:'Triagem por IA não configurada. Adicione ANTHROPIC_API_KEY nas variáveis do Railway.' });
      const TYPES = ['technical_support','complaint','rma','operational_problem','delivery_problem','incomplete_order','warranty','exchange_return','billing_issue','other'];
      const TYPES_PT = 'technical_support=Suporte Técnico | complaint=Reclamação | rma=RMA/Defeito | operational_problem=Problema Operacional | delivery_problem=Atraso de Entrega | incomplete_order=Pedido Incompleto | warranty=Garantia | exchange_return=Troca/Devolução | billing_issue=Problema Fiscal | other=Outro';
      const AREAS = ['support','operations','sales','purchasing','warehouse','fiscal','rma','financial'];
      const AREAS_PT = 'support=Suporte Técnico | operations=Operações/CD | sales=Comercial | purchasing=Compras | warehouse=CD/Estoque | fiscal=Fiscal | rma=RMA | financial=Financeiro';
      const prompt = `Você é especialista em Customer Success & Operations (CSO) do Grupo Nextra, distribuidora B2B de tecnologia (LED/PRO AV, Segurança Eletrônica, Áudio e Vídeo, Cabeamento Estruturado).

Analise a ocorrência de pós-venda e classifique:

Cliente: ${client_name||'não informado'}
BU: ${business_unit_id||'led'}
Produto: ${product||'não informado'}
Descrição: ${description}
${expectation?`Expectativa do cliente: ${expectation}`:''}
${previous_action?`Ação já tentada: ${previous_action}`:''}

Responda APENAS com JSON válido, sem markdown, sem texto antes ou depois:
{"occurrence_type":"um de: ${TYPES.join('|')}","criticality":"critical|high|medium|low","notify_areas":["subconjunto de: ${AREAS.join(',')}"],"root_cause_hypothesis":"hipótese de causa raiz em 1 frase objetiva","next_steps":"2 a 3 próximos passos separados por ;","client_communication":"rascunho de primeira resposta ao cliente, tom profissional e empático, máximo 3 linhas"}`;
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({ model:'claude-sonnet-4-6', max_tokens:900, messages:[{role:'user',content:prompt}] })
        });
        const d = await r.json();
        if (!r.ok) return reply.code(502).send({ error:'AI_ERROR', message:d.error?.message||'Erro na API de IA.' });
        const txt = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').replace(/```json|```/g,'').trim();
        const result = JSON.parse(txt);
        return { success:true, result };
      } catch(e) {
        return reply.code(502).send({ error:'AI_PARSE_ERROR', message:'Não foi possível processar a resposta da IA: '+e.message });
      }
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
      const safe = (q) => q.catch(() => ({ rows: [] }));
      const [byStatus,byArea,byType,retByStatus,csatByClient,revRisk,rmaByStatus,
             returnsSavings,rmaFinancial,rmaRecurrence,complaintsByCausingArea,
             amPerformance,clientRiskList,npsTrend,slaByArea,agingBuckets,channelDist,
             returnsRootCause,topComplaintClients] = await Promise.all([
        safe(db.query(`SELECT status, COUNT(*)::int AS count FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`)),
        safe(db.query(`SELECT area_responsible AS area, COUNT(*)::int AS count, COALESCE(SUM(revenue_at_risk),0) AS revenue_at_risk FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY area_responsible ORDER BY count DESC`)),
        safe(db.query(`SELECT type_key AS type, COUNT(*)::int AS count FROM complaints WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY type_key ORDER BY count DESC`)),
        safe(db.query(`SELECT status, COUNT(*)::int AS count FROM returns WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`)),
        // csat/nps/health_score ainda não existem no schema (Lote F/G) — falham isoladas até lá.
        safe(db.query(`SELECT cl.name, ROUND(AVG(cs.score),1) AS csat_avg, COUNT(cs.id)::int AS responses FROM csat cs LEFT JOIN clients cl ON cl.id=cs.client_id WHERE cs.collection_date>=CURRENT_DATE-${days} GROUP BY cl.name ORDER BY csat_avg ASC LIMIT 10`)),
        safe(db.query(`SELECT cl.name, SUM(t.revenue_at_risk) AS total FROM tickets t LEFT JOIN clients cl ON cl.id=t.client_id WHERE t.revenue_at_risk>0 AND t.status NOT IN ('closed') GROUP BY cl.name ORDER BY total DESC LIMIT 8`)),
        safe(db.query(`SELECT status, COUNT(*)::int AS count FROM rma WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY status ORDER BY count DESC`)),
        safe(db.query(`SELECT * FROM view_returns_savings`)),
        safe(db.query(`SELECT * FROM view_rma_financial`)),
        safe(db.query(`SELECT * FROM view_rma_recurrence LIMIT 10`)),
        safe(db.query(`SELECT causing_area, COUNT(*)::int AS count FROM complaints WHERE causing_area IS NOT NULL AND created_at>=NOW()-INTERVAL '${days} days' GROUP BY causing_area ORDER BY count DESC`)),
        safe(db.query(`
          SELECT u.id, u.name, COUNT(t.id)::int AS tickets_managed,
            COALESCE(SUM(t.revenue_at_risk) FILTER (WHERE t.status NOT IN ('closed')),0) AS open_revenue_at_risk,
            ROUND(AVG(EXTRACT(EPOCH FROM (t.resolved_at-t.created_at))/3600) FILTER (WHERE t.resolved_at IS NOT NULL),1) AS avg_resolution_hours
          FROM users u LEFT JOIN tickets t ON t.am_user_id=u.id
          WHERE u.role IN ('sales','operations') GROUP BY u.id,u.name HAVING COUNT(t.id) > 0 ORDER BY tickets_managed DESC LIMIT 10`)),
        safe(db.query(`SELECT id,name,health_score,health_status,segment FROM clients WHERE health_score < 60 AND is_active=TRUE ORDER BY health_score ASC LIMIT 15`)),
        safe(db.query(`SELECT TO_CHAR(DATE_TRUNC('week',collection_date),'DD/MM') AS week, ROUND(AVG(CASE WHEN score>=9 THEN 100 WHEN score>=7 THEN 0 ELSE -100 END))::int AS nps_score FROM nps WHERE collection_date>=NOW()-INTERVAL '${days} days' GROUP BY DATE_TRUNC('week',collection_date) ORDER BY 1`)),
        safe(db.query(`SELECT area_responsible AS area, COUNT(*) FILTER (WHERE sla_state='overdue')::int AS overdue, COUNT(*) FILTER (WHERE sla_state NOT IN ('overdue'))::int AS on_time FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY area_responsible`)),
        safe(db.query(`SELECT
            COUNT(*) FILTER (WHERE NOW()-created_at < INTERVAL '1 day')::int AS d0_1,
            COUNT(*) FILTER (WHERE NOW()-created_at BETWEEN INTERVAL '1 day' AND INTERVAL '3 days')::int AS d1_3,
            COUNT(*) FILTER (WHERE NOW()-created_at BETWEEN INTERVAL '3 days' AND INTERVAL '7 days')::int AS d3_7,
            COUNT(*) FILTER (WHERE NOW()-created_at > INTERVAL '7 days')::int AS d7_plus
          FROM tickets WHERE status NOT IN ('closed')`)),
        safe(db.query(`SELECT channel, COUNT(*)::int AS count FROM tickets WHERE created_at>=NOW()-INTERVAL '${days} days' GROUP BY channel ORDER BY count DESC`)),
        safe(db.query(`SELECT root_cause, COUNT(*)::int AS count FROM returns WHERE root_cause IS NOT NULL AND created_at>=NOW()-INTERVAL '${days} days' GROUP BY root_cause ORDER BY count DESC`)),
        safe(db.query(`SELECT cl.name, COUNT(c.id)::int AS complaint_count FROM complaints c LEFT JOIN clients cl ON cl.id=c.client_id WHERE c.created_at>=NOW()-INTERVAL '${days} days' GROUP BY cl.name ORDER BY complaint_count DESC LIMIT 8`)),
      ]);
      return { period_days:days, tickets_by_status:byStatus.rows, tickets_by_area:byArea.rows,
        complaints_by_type:byType.rows, returns_by_status:retByStatus.rows,
        csat_by_client:csatByClient.rows, revenue_at_risk:revRisk.rows, rma_by_status:rmaByStatus.rows,
        returns_savings: returnsSavings.rows, rma_financial: rmaFinancial.rows, rma_recurrence: rmaRecurrence.rows,
        complaints_by_causing_area: complaintsByCausingArea.rows, am_performance: amPerformance.rows,
        client_risk_list: clientRiskList.rows, nps_trend: npsTrend.rows, sla_by_area: slaByArea.rows,
        aging_buckets: agingBuckets.rows[0]||{}, channel_distribution: channelDist.rows,
        returns_root_cause: returnsRootCause.rows, top_complaint_clients: topComplaintClients.rows };
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
