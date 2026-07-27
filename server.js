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
const ExcelJS     = require('exceljs');

// ── DB ─────────────────────────────────────────────────────────
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = {
  query: (sql, params) => pool.query(sql, params),
  healthCheck: async () => { try { await pool.query('SELECT 1'); return true; } catch { return false; } }
};
let redis = null; // atribuído em buildApp() se REDIS_URL estiver configurada — usado para blocklist de logout

// ── JWT helpers ────────────────────────────────────────────────
const JWT_SECRET  = process.env.JWT_SECRET || 'nextra_cso_dev_secret';
if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'nextra_cso_dev_secret')) {
  console.error('✗ ERRO FATAL: JWT_SECRET não configurado (ou usando o valor padrão de desenvolvimento) em produção.');
  console.error('  Configure uma variável JWT_SECRET forte e única nas variáveis de ambiente do Railway antes de subir.');
  process.exit(1);
}
const JWT_EXPIRES = process.env.JWT_EXPIRES_IN || '8h';
const signToken   = (payload) => jwt.sign({ ...payload, jti: crypto.randomUUID() }, JWT_SECRET, { expiresIn: JWT_EXPIRES });
const verifyToken = (token)   => jwt.verify(token, JWT_SECRET);

// ── v2.2: Google Drive (opcional, modo duplo) ──────────────────
// Espelha cada anexo numa pasta por atendimento dentro do Drive.
// MODO OAUTH (recomendado p/ Gmail pessoal): configure GOOGLE_OAUTH_CLIENT_ID
//   e GOOGLE_OAUTH_CLIENT_SECRET no Railway e conecte a conta em
//   Configurações → Integrações. Os arquivos ficam na conta conectada
//   (cota de 15GB dela) e a pasta-raiz "Nextra CSO Hub — Atendimentos"
//   é criada automaticamente pelo próprio sistema.
// MODO CONTA DE SERVIÇO (p/ Workspace/Drive Compartilhado): GOOGLE_SA_EMAIL,
//   GOOGLE_SA_PRIVATE_KEY e DRIVE_ROOT_FOLDER_ID.
// Sem nenhum dos dois, os anexos continuam funcionando normalmente no
// Postgres — o Drive é só um espelho e nunca bloqueia o upload.
let _driveToken = null, _driveTokenExp = 0;
let _appSettingsCache = {};

async function getSetting(key) {
  try {
    const { rows } = await db.query('SELECT value FROM app_settings WHERE key=$1', [key]);
    return rows.length ? rows[0].value : null;
  } catch { return null; }
}
async function setSetting(key, value) {
  await db.query(
    `INSERT INTO app_settings (key,value,updated_at) VALUES ($1,$2,NOW())
     ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=NOW()`, [key, value]);
  _appSettingsCache[key] = value;
}
async function delSetting(key) {
  await db.query('DELETE FROM app_settings WHERE key=$1', [key]).catch(() => {});
  delete _appSettingsCache[key];
}

function driveMode() {
  if (process.env.GOOGLE_OAUTH_CLIENT_ID && process.env.GOOGLE_OAUTH_CLIENT_SECRET) return 'oauth';
  if (process.env.GOOGLE_SA_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY && process.env.DRIVE_ROOT_FOLDER_ID) return 'sa';
  return null;
}

async function driveConfigured() {
  const mode = driveMode();
  if (mode === 'sa') return true;
  if (mode === 'oauth') {
    if (_appSettingsCache.drive_refresh_token) return true;
    const t = await getSetting('drive_refresh_token');
    if (t) { _appSettingsCache.drive_refresh_token = t; return true; }
    return false;
  }
  return false;
}

function invalidateDriveToken() { _driveToken = null; _driveTokenExp = 0; }

async function getDriveToken() {
  if (_driveToken && Date.now() < _driveTokenExp - 60000) return _driveToken;
  const mode = driveMode();
  let body;
  if (mode === 'oauth') {
    const refresh = _appSettingsCache.drive_refresh_token || await getSetting('drive_refresh_token');
    if (!refresh) throw new Error('Drive não conectado (Configurações → Integrações).');
    body = new URLSearchParams({
      grant_type: 'refresh_token', refresh_token: refresh,
      client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
      client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
    });
  } else {
    const now = Math.floor(Date.now() / 1000);
    const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({
      iss: process.env.GOOGLE_SA_EMAIL,
      scope: 'https://www.googleapis.com/auth/drive',
      aud: 'https://oauth2.googleapis.com/token',
      iat: now, exp: now + 3600,
    });
    // No Railway a chave é colada com \n literais — normaliza para quebras reais.
    const pem = process.env.GOOGLE_SA_PRIVATE_KEY.replace(/\\n/g, '\n');
    const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), pem).toString('base64url');
    body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + signature });
  }
  const r = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body, signal: AbortSignal.timeout(10000),
  });
  if (!r.ok) throw new Error(`Drive auth: HTTP ${r.status}`);
  const d = await r.json();
  _driveToken = d.access_token;
  _driveTokenExp = Date.now() + (d.expires_in || 3600) * 1000;
  return _driveToken;
}

// Pasta-raiz: no modo SA vem do env; no modo OAuth é criada pelo app na
// primeira vez ("Nextra CSO Hub — Atendimentos") e memorizada no banco.
async function driveRootFolder() {
  if (driveMode() === 'sa') return process.env.DRIVE_ROOT_FOLDER_ID;
  let id = _appSettingsCache.drive_root_folder_id || await getSetting('drive_root_folder_id');
  if (id) { _appSettingsCache.drive_root_folder_id = id; return id; }
  const token = await getDriveToken();
  const created = await (await fetch('https://www.googleapis.com/drive/v3/files?fields=id,webViewLink', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Nextra CSO Hub — Atendimentos', mimeType: 'application/vnd.google-apps.folder' }),
    signal: AbortSignal.timeout(10000),
  })).json();
  if (!created.id) throw new Error(`Drive: falha ao criar pasta-raiz (${created.error?.message || JSON.stringify(created).slice(0,120)})`);
  await setSetting('drive_root_folder_id', created.id);
  if (created.webViewLink) await setSetting('drive_root_link', created.webViewLink);
  return created.id;
}

// Encontra (ou cria) a pasta do atendimento dentro da pasta-raiz do Hub.
async function driveEnsureFolder(name) {
  const token = await getDriveToken();
  const root = await driveRootFolder();
  const q = encodeURIComponent(`name='${name.replace(/'/g, "\\'")}' and '${root}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`);
  const found = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000),
  })).json();
  if (found.files && found.files.length) return found.files[0].id;
  const created = await (await fetch('https://www.googleapis.com/drive/v3/files?supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, mimeType: 'application/vnd.google-apps.folder', parents: [root] }),
    signal: AbortSignal.timeout(10000),
  })).json();
  if (!created.id) throw new Error(`Drive: falha ao criar pasta (${created.error?.message || JSON.stringify(created).slice(0,120)})`);
  return created.id;
}

// Sobe o arquivo (multipart) para a pasta e devolve o link de visualização.
async function driveUploadFile(folderId, filename, mime, buffer) {
  const token = await getDriveToken();
  const boundary = 'nxt' + crypto.randomBytes(12).toString('hex');
  const meta = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${meta}\r\n--${boundary}\r\nContent-Type: ${mime || 'application/octet-stream'}\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--`),
  ]);
  const r = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/related; boundary=${boundary}` },
    body, signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) throw new Error(`Drive upload: HTTP ${r.status}`);
  const d = await r.json();
  return d.webViewLink || (d.id ? `https://drive.google.com/file/d/${d.id}/view` : null);
}

const DRIVE_FOLDER_PREFIX = { ticket: 'CHAMADO', return: 'DEVOLUCAO', rma: 'RMA', complaint: 'RECLAMACAO', survey: 'PESQUISA' };

// ── v3.2: BACKUP AUTOMÁTICO DO BANCO ────────────────────────────
// Dump lógico diário (todas as tabelas em JSON gzip) para a pasta
// BACKUPS do Drive, com retenção de 30 arquivos. Anexos entram só
// como metadados — os arquivos em si já vivem espelhados no Drive.
const zlib = require('zlib');
let _backupRunning = false;

async function driveListFolder(folderId) {
  const token = await getDriveToken();
  const q = encodeURIComponent(`'${folderId}' in parents and trashed=false`);
  const r = await (await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id,name)&pageSize=200&supportsAllDrives=true&includeItemsFromAllDrives=true`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) })).json();
  return r.files || [];
}
async function driveDeleteFile(fileId) {
  const token = await getDriveToken();
  await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?supportsAllDrives=true`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(10000) }).catch(() => {});
}

// Gera o dump: { tabela: [linhas...] } — attachments sem a coluna binária.
async function buildDbDump() {
  const { rows: tabs } = await db.query(
    `SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename`);
  const dump = { _meta: { generated_at: new Date().toISOString(), app: 'nextra-cso-hub', format: 1 } };
  let totalRows = 0;
  for (const { tablename } of tabs) {
    if (tablename === 'attachments') {
      const { rows } = await db.query(`SELECT id,entity_type,entity_id,filename,mime,size_bytes,drive_url,uploaded_by,created_at FROM attachments ORDER BY id`);
      dump[tablename] = rows; totalRows += rows.length; continue;
    }
    const { rows } = await db.query(`SELECT * FROM "${tablename}"`);
    dump[tablename] = rows; totalRows += rows.length;
  }
  const gz = zlib.gzipSync(Buffer.from(JSON.stringify(dump)), { level: 9 });
  return { gz, tables: tabs.length, totalRows };
}

async function runBackup(motivo = 'agendado') {
  if (_backupRunning) return { ok: false, reason: 'Backup já em andamento.' };
  _backupRunning = true;
  try {
    if (!(await driveConfigured())) return { ok: false, reason: 'Drive não conectado — backup precisa do Google Drive (Configurações → Integrações).' };
    const { gz, tables, totalRows } = await buildDbDump();
    const folderId = await driveEnsureFolder('BACKUPS');
    const nome = `cso-hub-backup-${new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10)}-${Date.now().toString(36)}.json.gz`;
    const url = await driveUploadFile(folderId, nome, 'application/gzip', gz);
    if (!url) throw new Error('upload retornou vazio');
    await setSetting('backup_last_at', new Date().toISOString());
    await setSetting('backup_last_link', url);
    await setSetting('backup_last_bytes', String(gz.length));
    // retenção: mantém os 30 mais recentes
    try {
      const files = (await driveListFolder(folderId)).filter(f => f.name.startsWith('cso-hub-backup-')).sort((a, b) => b.name.localeCompare(a.name));
      for (const f of files.slice(30)) await driveDeleteFile(f.id);
    } catch (e) { console.error('backupRetention:', e.message); }
    console.log(`backup ${motivo}: ${nome} (${tables} tabelas, ${totalRows} linhas, ${(gz.length/1024).toFixed(0)}KB)`);
    return { ok: true, file: nome, drive_url: url, tables, rows: totalRows, bytes: gz.length };
  } catch (e) {
    console.error('backup:', e.message);
    await notifyAdmins('backup_failed', `⚠️ Backup automático falhou: ${e.message}`, null, 'settings').catch(() => {});
    return { ok: false, reason: e.message };
  } finally { _backupRunning = false; }
}

// Agendador: confere a cada 30 min; roda 1x/dia a partir das 03:00 (Brasília).
async function backupScheduler() {
  try {
    const hourBrt = new Date(Date.now() - 3 * 3600000).getUTCHours();
    if (hourBrt < 3) return;
    const hoje = new Date(Date.now() - 3 * 3600000).toISOString().slice(0, 10);
    const last = await getSetting('backup_last_at');
    const lastDay = last ? new Date(new Date(last).getTime() - 3 * 3600000).toISOString().slice(0, 10) : null;
    if (lastDay === hoje) return;
    if (!(await driveConfigured())) return;
    await runBackup('agendado');
  } catch (e) { console.error('backupScheduler:', e.message); }
}


// Best-effort: falha do Drive nunca derruba o upload principal (Postgres).
async function driveMirror(etype, eid, filename, mime, buffer) {
  if (!(await driveConfigured())) return null;
  try {
    const folderId = await driveEnsureFolder(`${DRIVE_FOLDER_PREFIX[etype] || etype.toUpperCase()}-${eid}`);
    return await driveUploadFile(folderId, filename, mime, buffer);
  } catch (e) {
    console.error('driveMirror:', e.message);
    if (String(e.message).includes('401')) invalidateDriveToken();
    return null;
  }
}

// ── v2.0: E-mail via Resend API (fetch nativo — zero dependência) ──
// Configure RESEND_API_KEY (e opcionalmente EMAIL_FROM) no Railway para ativar.
async function sendEmail(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return { sent: false, reason: 'E-mail não configurado (defina RESEND_API_KEY no Railway).' };
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM || 'Nextra CSO Hub <onboarding@resend.dev>', to: [to], subject, html }),
      signal: AbortSignal.timeout(10000),
    });
    if (!r.ok) { const e = await r.json().catch(() => ({})); return { sent: false, reason: e.message || `HTTP ${r.status}` }; }
    return { sent: true };
  } catch (e) { return { sent: false, reason: e.message }; }
}

// ── v2.0: Notificações in-app ──────────────────────────────────
async function notifyUsers(userIds, type, message, ticketId = null, linkView = null) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  for (const uid of ids) {
    await db.query(
      `INSERT INTO notifications (user_id, ticket_id, type, message, link_view) VALUES ($1,$2,$3,$4,$5)`,
      [uid, ticketId, type, message, linkView]
    ).catch(() => {});
  }
}
async function notifyAdmins(type, message, ticketId = null, linkView = null) {
  const { rows } = await db.query(`SELECT id FROM users WHERE role='admin' AND COALESCE(is_active,TRUE)`).catch(() => ({ rows: [] }));
  await notifyUsers(rows.map(r => r.id), type, message, ticketId, linkView);
}

// v3.0.1: recalcula a média de CSAT do cliente após cada resposta
async function refreshClientCsat(clientId) {
  if (!clientId) return;
  await db.query(`UPDATE clients SET csat_avg = sub.avg, updated_at = NOW()
    FROM (SELECT ROUND(AVG(score)::numeric, 1) AS avg FROM csat WHERE client_id = $1) sub
    WHERE clients.id = $1`, [clientId]).catch(() => {});
}

// v3.0.1: PATCHes com whitelist passam a declarar o que foi ignorado,
// em vez de descartar em silêncio (e registram no log do servidor).
function withIgnored(row, body, allowed) {
  const unknown = Object.keys(body || {}).filter(k => !allowed.includes(k));
  if (!unknown.length) return row;
  console.warn(`PATCH ignorou campos desconhecidos: ${unknown.join(', ')}`);
  return { ...row, _ignored_fields: unknown, _hint: 'Campos fora da whitelist desta rota — verifique o nome.' };
}

// ── v3.0: E-mails transacionais ─────────────────────────────────
const TICKET_STATUS_LABEL_SRV = {
  new:'Novo', in_triage:'Em triagem', awaiting_info:'Aguardando informações',
  in_technical_analysis:'Em análise técnica', awaiting_cd_ops:'Aguardando CD/Operações',
  awaiting_supplier:'Aguardando fornecedor', awaiting_fiscal:'Aguardando fiscal',
  in_resolution:'Em resolução', awaiting_client_validation:'Aguardando validação do cliente',
  resolved:'Resolvido', closed:'Encerrado', reopened:'Reaberto',
};
const AREA_LABEL_SRV = {
  support:'Suporte Técnico', operations:'Operações/CD', sales:'Comercial',
  purchasing:'Compras', warehouse:'CD/Estoque', fiscal:'Fiscal', rma:'RMA',
  cso:'CSO/Pós-venda', admin:'Administração', board:'Diretoria',
};
function emailTemplate(title, rows, ctaUrl) {
  const linhas = rows.filter(r => r && r[1]).map(([k,v]) =>
    `<tr><td style="padding:6px 10px;color:#888;font-size:12px;white-space:nowrap">${k}</td><td style="padding:6px 10px;font-size:13px;color:#222">${v}</td></tr>`).join('');
  return `<div style="font-family:Arial,sans-serif;max-width:560px;margin:auto;padding:20px">
    <div style="font-weight:bold;color:#1a1a2e;font-size:15px;margin-bottom:4px">Nextra CSO Hub</div>
    <h2 style="color:#1a1a2e;font-size:18px;margin:6px 0 14px">${title}</h2>
    <table style="border-collapse:collapse;background:#f7f7fa;border-radius:8px;width:100%">${linhas}</table>
    ${ctaUrl ? `<p style="text-align:center;margin:22px 0"><a href="${ctaUrl}" style="background:#e94560;color:#fff;padding:11px 26px;border-radius:8px;text-decoration:none;font-weight:bold">Abrir no Hub</a></p>` : ''}
    <p style="font-size:11px;color:#aaa">Mensagem automática do Nextra CSO Hub — não responda este e-mail.</p></div>`;
}
function hubUrl(req) { return (process.env.PUBLIC_BASE_URL || (req ? `${req.protocol}://${req.headers.host}` : '')).replace(/\/$/, ''); }
// Envia para uma lista de usuários (só quem tem e-mail cadastrado). Best-effort.
async function emailUsersByIds(ids, subject, html) {
  const clean = [...new Set((ids||[]).filter(Boolean))];
  if (!clean.length) return;
  const { rows } = await db.query(`SELECT email FROM users WHERE id = ANY($1) AND COALESCE(is_active,TRUE) AND email IS NOT NULL AND email <> ''`, [clean]).catch(()=>({rows:[]}));
  for (const r of rows) sendEmail(r.email, subject, html).catch(()=>{});
}
async function emailUsersByRoles(roles, subject, html) {
  const clean = [...new Set((roles||[]).filter(Boolean))];
  if (!clean.length) return;
  const { rows } = await db.query(`SELECT email FROM users WHERE role = ANY($1::user_role[]) AND COALESCE(is_active,TRUE) AND email IS NOT NULL AND email <> ''`, [clean]).catch(()=>({rows:[]}));
  for (const r of rows) sendEmail(r.email, subject, html).catch(()=>{});
}
// E-mail de AÇÃO para as áreas responsáveis/notificadas de um chamado
function emailAreas(ticket, areas, motivo, req) {
  const rows = [
    ['Chamado', ticket.id], ['Cliente', ticket.client_name],
    ['Criticidade', (ticket.criticality||'').toUpperCase()],
    ['Prazo SLA', ticket.sla_deadline ? new Date(ticket.sla_deadline).toLocaleString('pt-BR') : null],
    ['Áreas acionadas', (areas||[]).map(a => AREA_LABEL_SRV[a]||a).join(', ')],
    ['Descrição', String(ticket.description||'').slice(0,300)],
    ['O que se espera', String(ticket.expectation||'').slice(0,300)],
  ];
  return emailUsersByRoles(areas, `[AÇÃO] ${ticket.id} — ${motivo}`, emailTemplate(`Sua área foi acionada: ${motivo}`, rows, hubUrl(req)));
}
// E-mail de ACOMPANHAMENTO para o AM/BDM do chamado (criação, kanban, encerramento)
function emailAmBdm(ticket, titulo, extraRows, req) {
  const rows = [
    ['Chamado', ticket.id], ['Cliente', ticket.client_name],
    ['Criticidade', (ticket.criticality||'').toUpperCase()],
    ...(extraRows||[]),
  ];
  return emailUsersByIds([ticket.am_user_id, ticket.bdm_user_id], `${ticket.id} — ${titulo}`, emailTemplate(titulo, rows, hubUrl(req)));
}

// ── v2.0: Validação de CNPJ (servidor) ─────────────────────────
function isValidCNPJSrv(raw) {
  const c = String(raw || '').replace(/\D/g, '');
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len) => {
    const w = len === 12 ? [5,4,3,2,9,8,7,6,5,4,3,2] : [6,5,4,3,2,9,8,7,6,5,4,3,2];
    let s = 0; for (let i = 0; i < len; i++) s += parseInt(c[i]) * w[i];
    const r = s % 11; return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === parseInt(c[12]) && calc(13) === parseInt(c[13]);
}

// ── v2.0: SLA em horas ÚTEIS (business_hours + holidays) ───────
// Caminha dia a dia consumindo apenas janelas de expediente. Se as tabelas
// estiverem vazias/indisponíveis, cai no comportamento antigo (horas corridas).
async function computeSlaDeadline(hours) {
  try {
    // v3.0.1: toda a matemática de expediente roda no fuso comercial
    // (BUSINESS_TZ_OFFSET, padrão -03:00 = Brasília), não no UTC do servidor.
    const offStr = process.env.BUSINESS_TZ_OFFSET || '-03:00';
    const om = /^([+-])(\d{2}):(\d{2})$/.exec(offStr) || ['', '-', '03', '00'];
    const OFF = (om[1] === '-' ? -1 : 1) * (parseInt(om[2]) * 60 + parseInt(om[3])) * 60000;
    const [bh, hol] = await Promise.all([
      db.query(`SELECT day_of_week, start_time, end_time FROM business_hours WHERE is_active AND business_unit_id IS NULL`),
      db.query(`SELECT date FROM holidays`),
    ]);
    if (!bh.rows.length) return new Date(Date.now() + hours * 3600000);
    const byDow = {};
    for (const r of bh.rows) byDow[r.day_of_week] = r; // 1 janela por dia (padrão)
    const holidays = new Set(hol.rows.map(r => new Date(r.date).toISOString().slice(0, 10)));
    let remaining = Math.round(hours * 60); // minutos úteis restantes
    // cursor "deslocado": os acessores UTC passam a representar o relógio de parede local
    let cursor = new Date(Date.now() + OFF);
    for (let guard = 0; guard < 400 && remaining > 0; guard++) {
      const dayKey = cursor.toISOString().slice(0, 10);
      const win = byDow[cursor.getUTCDay()];
      if (!win || holidays.has(dayKey)) { // dia sem expediente → pula para o próximo, 00:00
        cursor = new Date(cursor); cursor.setUTCDate(cursor.getUTCDate() + 1); cursor.setUTCHours(0, 0, 0, 0); continue;
      }
      const [sh, sm] = String(win.start_time).split(':').map(Number);
      const [eh, em] = String(win.end_time).split(':').map(Number);
      const start = new Date(cursor); start.setUTCHours(sh, sm, 0, 0);
      const end   = new Date(cursor); end.setUTCHours(eh, em, 0, 0);
      const from = cursor > start ? cursor : start;
      if (from >= end) { cursor = new Date(cursor); cursor.setUTCDate(cursor.getUTCDate() + 1); cursor.setUTCHours(0, 0, 0, 0); continue; }
      const capacity = Math.floor((end - from) / 60000);
      if (remaining <= capacity) return new Date(from.getTime() + remaining * 60000 - OFF); // volta ao tempo real
      remaining -= capacity;
      cursor = new Date(cursor); cursor.setUTCDate(cursor.getUTCDate() + 1); cursor.setUTCHours(0, 0, 0, 0);
    }
    return new Date(Date.now() + hours * 3600000); // fallback de segurança
  } catch { return new Date(Date.now() + hours * 3600000); }
}

// ── v2.0: Varredura de SLA — o fix do bug de "overdue" ─────────
// Antes, um chamado só virava 'overdue' quando alguém mexia nele. Esta
// varredura roda no boot e a cada 5 min, marcando estourados e notificando.
async function slaSweep() {
  try {
    const { rows } = await db.query(`
      UPDATE tickets SET sla_state='overdue', updated_at=NOW()
      WHERE sla_deadline < NOW() AND sla_state IN ('ok','warn') AND status NOT IN ('closed','resolved')
      RETURNING id, client_name, am_user_id, created_by_user_id`);
    for (const t of rows) {
      const msg = `⏰ SLA ESTOURADO: chamado ${t.id} (${t.client_name || 'cliente não informado'}) ultrapassou o prazo.`;
      await notifyUsers([t.am_user_id, t.created_by_user_id], 'sla_overdue', msg, t.id, 'tickets');
      await notifyAdmins('sla_overdue', msg, t.id, 'tickets');
      // v3.0: alerta crítico também por e-mail (AM do chamado + admins)
      const html = emailTemplate('⏰ SLA estourado', [['Chamado', t.id], ['Cliente', t.client_name],
        ['Prazo', t.sla_deadline ? new Date(t.sla_deadline).toLocaleString('pt-BR') : null],
        ['Descrição', String(t.description||'').slice(0,200)]], hubUrl(null));
      emailUsersByIds([t.am_user_id], `[URGENTE] SLA estourado — ${t.id}`, html).catch(()=>{});
      emailUsersByRoles(['admin'], `[URGENTE] SLA estourado — ${t.id}`, html).catch(()=>{});
    }
  } catch (e) { console.error('slaSweep:', e.message); }
  // v3.0: RMA parado há mais de 7 dias sem atualização — alerta único por semana
  try {
    const { rows: stuck } = await db.query(`
      SELECT r.id, r.product_name, cl.name AS client_name FROM rma r
      LEFT JOIN clients cl ON cl.id=r.client_id
      WHERE r.status NOT IN ('closed','completed','cancelled')
        AND r.updated_at < NOW() - INTERVAL '7 days'
        AND NOT EXISTS (SELECT 1 FROM notifications n WHERE n.type='rma_stuck'
          AND n.message LIKE '%' || r.id || '%' AND n.created_at > NOW() - INTERVAL '7 days')
      LIMIT 20`);
    for (const r of stuck) {
      const msg = `🔧 RMA #${r.id} (${r.client_name || 'sem cliente'} · ${r.product_name || 'produto'}) está sem movimentação há mais de 7 dias.`;
      await notifyAdmins('rma_stuck', msg, null, 'rma');
      emailUsersByRoles(['admin','rma'], `[ATENÇÃO] RMA #${r.id} parado há 7+ dias`,
        emailTemplate('🔧 RMA sem movimentação', [['RMA', '#'+r.id], ['Cliente', r.client_name],
          ['Produto', r.product_name], ['Situação', 'Mais de 7 dias sem atualização']], hubUrl(null))).catch(()=>{});
    }
  } catch (e) { console.error('rmaStuckSweep:', e.message); }
}

// ── Auth middleware ────────────────────────────────────────────
async function authenticate(req, reply) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!token) return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Token obrigatório.', status: 401 });
  try {
    const payload = verifyToken(token);
    // Se Redis está disponível, respeita a blocklist de tokens invalidados
    // por logout — sem Redis, o token continua válido até expirar (limitação
    // conhecida e documentada de JWT stateless sem esta camada extra).
    if (redis && payload.jti) {
      const blocked = await redis.get(`blocklist:${payload.jti}`).catch(() => null);
      if (blocked) return reply.code(401).send({ error: 'TOKEN_REVOKED', message: 'Sessão encerrada. Faça login novamente.', status: 401 });
    }
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

async function auditLog(req, action, entity, entityId, oldData, newData) {
  try {
    const user = req.user;
    await db.query(
      `INSERT INTO audit_log (user_id, action, entity, entity_id, old_data, new_data, ip_address, user_agent)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [user?.sub || null, action, entity, String(entityId),
       oldData ? JSON.stringify(oldData) : null,
       newData ? JSON.stringify(newData) : null,
       req.ip || null, req.headers?.['user-agent'] || null]
    );
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────
const send404 = (reply) => reply.code(404).send({ error: 'NOT_FOUND', status: 404 });
const send422 = (reply, msg, code) => reply.code(422).send({ error: code, message: msg, status: 422 });
const v_defined = (v) => v !== undefined && v !== null && v !== '';

// Grafo de transições válidas de status de Chamado — fonte única de verdade,
// usado tanto pela edição de status quanto pelo Kanban. Qualquer transição
// fora deste grafo é bloqueada com 409, mesmo que venha do Kanban (drag&drop)
// ou de qualquer outro cliente.
const TICKET_STATUS_TRANSITIONS = {
  new: ['in_triage'],
  in_triage: ['awaiting_info', 'in_technical_analysis', 'awaiting_cd_ops', 'reopened'],
  awaiting_info: ['in_triage', 'in_technical_analysis'],
  in_technical_analysis: ['awaiting_supplier', 'awaiting_fiscal', 'in_resolution'],
  awaiting_cd_ops: ['in_resolution'],
  awaiting_supplier: ['in_technical_analysis', 'in_resolution'],
  awaiting_fiscal: ['in_technical_analysis', 'in_resolution'],
  in_resolution: ['awaiting_client_validation', 'resolved'],
  awaiting_client_validation: ['in_resolution', 'resolved'],
  resolved: ['closed'],
  closed: [],
  reopened: ['in_triage'],
};

// ── Build Fastify app ──────────────────────────────────────────
async function buildApp() {
  const app = Fastify({
    logger: { level: process.env.NODE_ENV === 'production' ? 'warn' : 'info' },
    trustProxy: true,
    bodyLimit: 15 * 1024 * 1024, // v2.0: uploads de anexos (base64) até ~10MB reais
  });

  await app.register(helmet, { contentSecurityPolicy: false });

  const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (!allowedOrigins.length) {
    app.log.warn('ALLOWED_ORIGINS não configurada — CORS aceitará qualquer origem. Configure essa variável em produção para restringir.');
  }
  await app.register(cors, {
    origin: (origin, cb) => {
      // Sem origin (chamadas same-origin, curl, apps mobile) sempre passam.
      if (!origin) return cb(null, true);
      if (!allowedOrigins.length) return cb(null, true); // fallback permissivo se não configurado
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('Origem não permitida por CORS.'), false);
    },
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    credentials: true,
  });

  await app.register(rl, {
    max: 200, timeWindow: 60000,
    errorResponseBuilder: () => ({ error: 'RATE_LIMIT_EXCEEDED', status: 429 }),
  });

  // Redis opcional
  if (process.env.REDIS_URL) {
    try {
      redis = new Redis(process.env.REDIS_URL, {
        lazyConnect: true, maxRetriesPerRequest: 2, connectTimeout: 3000,
        retryStrategy: (times) => (times > 10 ? null : Math.min(times * 200, 5000)), // limita reconexão, evita flood infinito de log
      });
      // CRÍTICO: sem este listener, um erro de conexão do Redis emitido de
      // forma assíncrona (após o boot) pode derrubar o processo inteiro em
      // algumas versões do Node/ioredis — Redis é opcional neste sistema,
      // uma falha nele nunca deve tirar o backend do ar.
      redis.on('error', (err) => { app.log.warn({ err: err.message }, 'Redis indisponível — seguindo sem cache.'); });
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
let reasons = [];
const CHIPS = {
  csat_low:  ['Demorou demais','Faltou comunicação','Problema voltou','Solução não atendeu','Atendimento ruim','Burocracia'],
  csat_high: ['Rapidez','Comunicação clara','Resolveu de vez','Equipe técnica','Facilidade'],
  nps_low:   ['Demorou demais','Faltou comunicação','Problema voltou','Solução não atendeu','Atendimento ruim','Burocracia','Preço/condições','Portfólio/disponibilidade'],
  nps_high:  ['Rapidez','Comunicação clara','Resolveu de vez','Equipe técnica','Facilidade','Preço/condições','Portfólio/disponibilidade'],
};
function chipsFor(isCsat, sc) {
  if (isCsat) return sc <= 3 ? { q:'O que mais pesou?', list:CHIPS.csat_low } : { q:'O que fez a diferença?', list:CHIPS.csat_high };
  if (sc <= 6) return { q:'O que precisaria mudar para a Nextra ser sua primeira opção?', list:CHIPS.nps_low };
  if (sc <= 8) return { q:'O que falta para nota 9 ou 10?', list:CHIPS.nps_low };
  return { q:'O que você mais valoriza?', list:CHIPS.nps_high };
}
function render(d) {
  const isCsat = d.survey_type === 'csat';
  app.innerHTML = '<div class="logo"><div class="dot"></div><span>Nextra CSO Hub</span></div>'+
    '<h1>Olá, '+(d.client_name||'cliente')+'!</h1>'+
    '<p>'+(isCsat?'Como foi a resolução do seu atendimento?':'De 0 a 10, o quanto você recomendaria a Nextra a um colega?')+'</p>'+
    (isCsat?'<div class="stars" id="stars">'+[1,2,3,4,5].map(n=>'<span class="star" data-v="'+n+'">★</span>').join('')+'</div>'
           :'<div class="nps-row" id="nps">'+Array.from({length:11},(_,n)=>'<button class="nps-btn" data-v="'+n+'">'+n+'</button>').join('')+'</div>')+
    '<div id="step2" style="display:none"><p id="chipq" style="margin-bottom:10px;font-weight:600;color:#1A1730"></p>'+
    '<div id="chips" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:18px"></div>'+
    '<textarea id="comment" placeholder="Quer contar mais? (opcional)"></textarea>'+
    '<button class="submit" id="send">Enviar resposta</button></div>';
  const picker = document.getElementById(isCsat?'stars':'nps');
  picker.addEventListener('click', e=>{
    const v = e.target.getAttribute('data-v'); if(v===null) return;
    score = parseInt(v); reasons = [];
    [...picker.children].forEach(c=>c.classList.toggle('active', parseInt(c.getAttribute('data-v'))<=score && isCsat || c===e.target && !isCsat));
    const cfg = chipsFor(isCsat, score);
    document.getElementById('chipq').textContent = cfg.q;
    document.getElementById('chips').innerHTML = cfg.list.map(c=>'<button type="button" class="chip" data-c="'+c+'" style="padding:8px 14px;border-radius:20px;border:1.5px solid #E4E0F5;background:#fff;font-size:13px;cursor:pointer;color:#1A1730">'+c+'</button>').join('');
    document.getElementById('step2').style.display = 'block';
    [...document.querySelectorAll('.chip')].forEach(ch=>ch.onclick=()=>{
      const c = ch.getAttribute('data-c');
      if (reasons.includes(c)) { reasons = reasons.filter(x=>x!==c); ch.style.background='#fff'; ch.style.color='#1A1730'; ch.style.borderColor='#E4E0F5'; }
      else { reasons.push(c); ch.style.background='#6D40E6'; ch.style.color='#fff'; ch.style.borderColor='#6D40E6'; }
    });
    document.getElementById('send').onclick = submit;
  });
}
async function submit() {
  const btn = document.getElementById('send'); btn.disabled = true; btn.textContent = 'Enviando...';
  try {
    const r = await fetch('/api/v1/public/survey/'+token, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ score, reasons, comment: document.getElementById('comment').value }) });
    if (!r.ok) throw new Error('Falha ao enviar');
    app.innerHTML = '<div class="done"><div class="icon">✅</div><h1>Obrigado!</h1><p>Sua resposta foi registrada — e vai direto para o time que cuida disso.</p></div>';
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
      return { token, user: { id: user.id, login: user.login, name: user.name, role: user.role, title: user.title, must_change_password: user.must_change_password === true } };
    });

    // v3.0: troca de senha pelo próprio usuário (obrigatória no 1º acesso)
    v1.post('/auth/change-password', { preHandler: [authenticate] }, async (req, reply) => {
      const { current_password, new_password } = req.body || {};
      if (!current_password || !new_password)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Senha atual e nova senha são obrigatórias.', status:400 });
      if (String(new_password).length < 8)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'A nova senha deve ter pelo menos 8 caracteres.', status:400 });
      if (String(new_password) === String(current_password))
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'A nova senha deve ser diferente da atual.', status:400 });
      const me = getUser(req);
      const { rows:[u] } = await db.query('SELECT id,password_hash FROM users WHERE id=$1', [me.sub]);
      if (!u || !(await bcrypt.compare(String(current_password), u.password_hash)))
        return reply.code(401).send({ error:'INVALID_CREDENTIALS', message:'Senha atual incorreta.', status:401 });
      const hash = await bcrypt.hash(String(new_password), 12);
      await db.query('UPDATE users SET password_hash=$2, must_change_password=FALSE, updated_at=NOW() WHERE id=$1', [me.sub, hash]);
      return { changed: true };
    });

    v1.post('/auth/logout', { preHandler: [authenticate] }, async (req, reply) => {
      // Invalida a sessão de verdade quando Redis está disponível — adiciona
      // o jti do token a uma blocklist com TTL igual ao tempo restante até a
      // expiração natural, para não crescer para sempre. Sem Redis, o
      // logout ainda funciona no frontend (limpa o token local), mas o
      // token em si permanece tecnicamente válido até expirar sozinho —
      // limitação conhecida de JWT stateless sem camada de blocklist.
      if (redis && req.user?.jti && req.user?.exp) {
        const ttlSeconds = req.user.exp - Math.floor(Date.now() / 1000);
        if (ttlSeconds > 0) await redis.set(`blocklist:${req.user.jti}`, '1', 'EX', ttlSeconds).catch(() => {});
      }
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

    v1.get('/business-units', { preHandler: [authenticate] }, async () => {
      const { rows } = await db.query(`SELECT id, name, color_hex FROM business_units WHERE is_active = true ORDER BY name`).catch(() => ({ rows: [] }));
      return { data: rows };
    });

    // Valida FK de unidade de negócio antes de INSERTs (evita erro cru do Postgres na UI)
    const assertBU = async (buId) => {
      if (!buId) return null;
      const { rows } = await db.query('SELECT 1 FROM business_units WHERE id=$1 AND is_active=true', [buId]);
      return rows.length ? null : `Unidade de negócio inválida: "${buId}". Atualize a página e selecione uma opção válida.`;
    };

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
      const { role, title } = req.query || {};
      const where = ['is_active=TRUE']; const params = [];
      if (role)  { params.push(role);  where.push(`role=$${params.length}`); }
      if (title) { params.push(title); where.push(`UPPER(COALESCE(title,''))=UPPER($${params.length})`); }
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
        INSERT INTO users (name,email,login,password_hash,role,title,access_level,department,phone,is_active,must_change_password)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,TRUE,TRUE)
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

    // ── SISTEMA / DIAGNÓSTICO (admin) ───────────────────────
    v1.get('/admin/db-status', { preHandler: [authorize('admin')] }, async () => {
      const tables = ['clients','tickets','complaints','returns','rma','csat','nps',
        'recovery_plans','survey_links','suppliers','users'];
      const counts = {};
      for (const t of tables) {
        try { const { rows } = await db.query(`SELECT COUNT(*)::int AS n FROM ${t}`); counts[t] = rows[0].n; }
        catch(e) { counts[t] = null; }
      }
      const { rows: migs } = await db.query('SELECT filename, applied_at FROM schema_migrations ORDER BY applied_at').catch(() => ({ rows: [] }));
      return { counts, migrations: migs };
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — ANEXOS (armazenados no Postgres; sobrevivem a redeploy)
    // ═══════════════════════════════════════════════════════════
    const ATTACH_TYPES = ['ticket','return','rma','complaint','survey'];
    const MAX_ATTACH = 10 * 1024 * 1024; // 10MB por arquivo

    v1.post('/attachments/:etype/:eid', { preHandler: [authenticate] }, async (req, reply) => {
      const { etype, eid } = req.params;
      if (!ATTACH_TYPES.includes(etype)) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Tipo de entidade inválido.', status:400 });
      const d = req.body || {};
      if (!d.filename || !d.data_base64) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'filename e data_base64 obrigatórios.', status:400 });
      let buf;
      try { buf = Buffer.from(d.data_base64, 'base64'); } catch { return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Base64 inválido.', status:400 }); }
      if (!buf.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Arquivo vazio.', status:400 });
      if (buf.length > MAX_ATTACH) return reply.code(400).send({ error:'FILE_TOO_LARGE', message:'Arquivo excede 10MB.', status:400 });
      const user = getUser(req);
      const { rows:[a] } = await db.query(
        `INSERT INTO attachments (entity_type,entity_id,filename,mime,size_bytes,data,uploaded_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id,entity_type,entity_id,filename,mime,size_bytes,created_at`,
        [etype, String(eid), String(d.filename).slice(0,255), d.mime||'application/octet-stream', buf.length, buf, user.sub]);
      // v2.1: espelha no Google Drive (se configurado) — nunca bloqueia o upload principal.
      const driveUrl = await driveMirror(etype, String(eid), a.filename, a.mime, buf);
      if (driveUrl) await db.query(`UPDATE attachments SET drive_url=$1 WHERE id=$2`, [driveUrl, a.id]).catch(() => {});
      return reply.code(201).send({ ...a, drive_url: driveUrl });
    });

    v1.get('/attachments/:etype/:eid', { preHandler: [authenticate] }, async (req, reply) => {
      const { etype, eid } = req.params;
      if (!ATTACH_TYPES.includes(etype)) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Tipo de entidade inválido.', status:400 });
      const { rows } = await db.query(
        `SELECT a.id,a.filename,a.mime,a.size_bytes,a.created_at,a.drive_url,u.name AS uploaded_by_name
         FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by
         WHERE a.entity_type=$1 AND a.entity_id=$2 ORDER BY a.created_at DESC`, [etype, String(eid)]);
      return rows;
    });

    v1.get('/attachments/file/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const { rows:[a] } = await db.query(`SELECT filename,mime,data FROM attachments WHERE id=$1`, [req.params.id]);
      if (!a) return send404(reply);
      return reply
        .header('Content-Type', a.mime || 'application/octet-stream')
        .header('Content-Disposition', `attachment; filename="${encodeURIComponent(a.filename)}"`)
        .send(a.data);
    });

    v1.delete('/attachments/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const user = getUser(req);
      const { rows:[a] } = await db.query(`SELECT uploaded_by FROM attachments WHERE id=$1`, [req.params.id]);
      if (!a) return send404(reply);
      if (user.role !== 'admin' && a.uploaded_by !== user.sub)
        return reply.code(403).send({ error:'FORBIDDEN', message:'Apenas o autor do upload ou um admin pode excluir.', status:403 });
      await db.query(`DELETE FROM attachments WHERE id=$1`, [req.params.id]);
      return { deleted: true };
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — CATÁLOGO DE PRODUTOS (fim do produto em texto livre)
    // ═══════════════════════════════════════════════════════════
    v1.get('/products', { preHandler: [authenticate] }, async (req) => {
      const q = (req.query.q || '').trim();
      const params = []; let where = 'WHERE p.is_active';
      if (q) { params.push(`%${q}%`); where += ` AND (p.name ILIKE $1 OR p.code ILIKE $1 OR p.model ILIKE $1)`; }
      const { rows } = await db.query(
        `SELECT p.*, s.name AS supplier_name FROM product_catalog p
         LEFT JOIN suppliers s ON s.id=p.supplier_id ${where} ORDER BY p.name LIMIT 200`, params);
      return rows;
    });

    v1.post('/products', { preHandler: [authorize('admin','manager')] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.name || !String(d.name).trim()) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nome do produto é obrigatório.', status:400 });
      try {
        const { rows:[p] } = await db.query(
          `INSERT INTO product_catalog (name,code,model,category,business_unit_id,supplier_id,warranty_months)
           VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
          [String(d.name).trim(), d.code||null, d.model||null, d.category||null, d.business_unit_id||'led',
           d.supplier_id||null, parseInt(d.warranty_months)||12]);
        return reply.code(201).send(p);
      } catch(e) {
        if (String(e.message).includes('unique')) return reply.code(409).send({ error:'DUPLICATE', message:'Já existe um produto com esse código.', status:409 });
        return reply.code(400).send({ error:'CREATE_FAILED', message:e.message, status:400 });
      }
    });

    v1.patch('/products/:id', { preHandler: [authorize('admin','manager')] }, async (req, reply) => {
      const d = req.body || {};
      const allowed = ['name','code','model','category','supplier_id','warranty_months','is_active'];
      const sets = [], vals = [];
      for (const k of allowed) if (k in d) { vals.push(d[k]); sets.push(`${k}=$${vals.length}`); }
      if (!sets.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nada para atualizar.', status:400 });
      vals.push(req.params.id);
      const { rows:[p] } = await db.query(`UPDATE product_catalog SET ${sets.join(',')}, updated_at=NOW() WHERE id=$${vals.length} RETURNING *`, vals);
      if (!p) return send404(reply);
      return p;
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — IMPORTAÇÃO EM MASSA (a "integração de pobre": CSV)
    // Frontend envia JSON já parseado; servidor valida e deduplica.
    // ═══════════════════════════════════════════════════════════
    v1.post('/import/clients', { preHandler: [authorize('admin','manager')] }, async (req, reply) => {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Envie rows: [{name, cnpj, city, state, segment}].', status:400 });
      if (rows.length > 2000) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Máximo de 2000 linhas por importação.', status:400 });
      let inserted = 0, skipped = 0, invalid = 0; const errors = [];
      for (const [i, r] of rows.entries()) {
        const name = String(r.name || '').trim();
        const cnpjRaw = String(r.cnpj || '').replace(/\D/g, '');
        if (!name) { invalid++; if (errors.length < 10) errors.push(`Linha ${i+1}: nome vazio`); continue; }
        if (cnpjRaw && !isValidCNPJSrv(cnpjRaw)) { invalid++; if (errors.length < 10) errors.push(`Linha ${i+1}: CNPJ inválido (${r.cnpj})`); continue; }
        const cnpjFmt = cnpjRaw ? cnpjRaw.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5') : null;
        const res = await db.query(
          `INSERT INTO clients (name,cnpj,city,state,segment,primary_bu)
           VALUES ($1,$2,$3,$4,$5,'led')
           ON CONFLICT (cnpj) DO NOTHING RETURNING id`,
          [name, cnpjFmt, r.city||null, (r.state||'').slice(0,2)||null, r.segment||null]).catch(e => { if (errors.length < 10) errors.push(`Linha ${i+1}: ${e.message}`); return { rows: [] }; });
        if (res.rows.length) inserted++; else skipped++;
      }
      return { inserted, skipped_duplicates: skipped, invalid, errors };
    });

    v1.post('/import/products', { preHandler: [authorize('admin','manager')] }, async (req, reply) => {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Envie rows: [{name, code, model, category, warranty_months}].', status:400 });
      if (rows.length > 2000) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Máximo de 2000 linhas por importação.', status:400 });
      let inserted = 0, skipped = 0, invalid = 0; const errors = [];
      for (const [i, r] of rows.entries()) {
        const name = String(r.name || '').trim();
        if (!name) { invalid++; if (errors.length < 10) errors.push(`Linha ${i+1}: nome vazio`); continue; }
        const res = await db.query(
          `INSERT INTO product_catalog (name,code,model,category,business_unit_id,warranty_months)
           VALUES ($1,$2,$3,$4,'led',$5)
           ON CONFLICT (code) DO NOTHING RETURNING id`,
          [name, r.code ? String(r.code).trim() : null, r.model||null, r.category||null, parseInt(r.warranty_months)||12]
        ).catch(e => { if (errors.length < 10) errors.push(`Linha ${i+1}: ${e.message}`); return { rows: [] }; });
        if (res.rows.length) inserted++; else skipped++;
      }
      return { inserted, skipped_duplicates: skipped, invalid, errors };
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — BUSCA GLOBAL (CNPJ, NF, serial, produto, cliente...)
    // ═══════════════════════════════════════════════════════════
    v1.get('/search', { preHandler: [authenticate] }, async (req, reply) => {
      const q = (req.query.q || '').trim();
      if (q.length < 2) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Informe ao menos 2 caracteres.', status:400 });
      const like = `%${q}%`;
      const safe = (p) => p.catch(() => ({ rows: [] }));
      const [clients, tickets, returns, rmas, complaints] = await Promise.all([
        safe(db.query(`SELECT id,name,cnpj,risk_level FROM clients WHERE name ILIKE $1 OR cnpj ILIKE $1 ORDER BY name LIMIT 6`, [like])),
        safe(db.query(`SELECT id,client_name,status,criticality,nf_number,product_name_snap FROM tickets
                       WHERE id ILIKE $1 OR client_name ILIKE $1 OR nf_number ILIKE $1 OR product_name_snap ILIKE $1 OR serial_number_snap ILIKE $1
                       ORDER BY created_at DESC LIMIT 6`, [like])),
        safe(db.query(`SELECT id,status,product_name_snap,nf_number FROM returns
                       WHERE product_name_snap ILIKE $1 OR nf_number ILIKE $1 OR CAST(id AS TEXT)=$2
                       ORDER BY created_at DESC LIMIT 6`, [like, q])),
        safe(db.query(`SELECT id,status,product_name,serial_number FROM rma
                       WHERE product_name ILIKE $1 OR serial_number ILIKE $1 OR product_code ILIKE $1 OR CAST(id AS TEXT)=$2
                       ORDER BY created_at DESC LIMIT 6`, [like, q])),
        safe(db.query(`SELECT c.id,c.status,c.severity,cl.name AS client_name FROM complaints c
                       LEFT JOIN clients cl ON cl.id=c.client_id
                       WHERE cl.name ILIKE $1 OR c.description ILIKE $1 ORDER BY c.created_at DESC LIMIT 6`, [like])),
      ]);
      return { clients: clients.rows, tickets: tickets.rows, returns: returns.rows, rma: rmas.rows, complaints: complaints.rows };
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — NOTIFICAÇÕES IN-APP (sino no topo)
    // ═══════════════════════════════════════════════════════════
    v1.get('/notifications', { preHandler: [authenticate] }, async (req) => {
      const user = getUser(req);
      const [items, unread] = await Promise.all([
        db.query(`SELECT id,type,message,ticket_id,link_view,is_read,created_at FROM notifications
                  WHERE user_id=$1 ORDER BY created_at DESC LIMIT 30`, [user.sub]),
        db.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id=$1 AND NOT is_read`, [user.sub]),
      ]);
      return { unread: unread.rows[0].n, items: items.rows };
    });

    v1.patch('/notifications/:id/read', { preHandler: [authenticate] }, async (req, reply) => {
      const user = getUser(req);
      const { rows } = await db.query(`UPDATE notifications SET is_read=TRUE, read_at=NOW() WHERE id=$1 AND user_id=$2 RETURNING id`, [req.params.id, user.sub]);
      if (!rows.length) return send404(reply);
      return { read: true };
    });

    v1.patch('/notifications/read-all', { preHandler: [authenticate] }, async (req) => {
      const user = getUser(req);
      await db.query(`UPDATE notifications SET is_read=TRUE, read_at=NOW() WHERE user_id=$1 AND NOT is_read`, [user.sub]);
      return { read: true };
    });

    // ═══════════════════════════════════════════════════════════
    // v2.0 — CONTADORES REAIS DO MENU (fim dos badges chumbados)
    // ═══════════════════════════════════════════════════════════
    v1.get('/menu-counts', { preHandler: [authenticate] }, async () => {
      const safe = (p) => p.catch(() => ({ rows: [{ n: 0 }] }));
      const [torre, tickets, complaints, returns_, rma_] = await Promise.all([
        safe(db.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE status NOT IN ('closed','resolved') AND (criticality='critical' OR (sla_state NOT IN ('done','paused') AND sla_deadline < NOW()))`)),
        safe(db.query(`SELECT COUNT(*)::int AS n FROM tickets WHERE status NOT IN ('closed','resolved')`)),
        safe(db.query(`SELECT COUNT(*)::int AS n FROM complaints WHERE status::text NOT IN ('closed','resolved','cancelled')`)),
        safe(db.query(`SELECT COUNT(*)::int AS n FROM returns WHERE status::text NOT IN ('rejected','closed','refund_or_credit_issued')`)),
        safe(db.query(`SELECT COUNT(*)::int AS n FROM rma WHERE status::text NOT IN ('closed','completed','cancelled')`)),
      ]);
      return { torre: torre.rows[0].n, tickets: tickets.rows[0].n, complaints: complaints.rows[0].n, returns: returns_.rows[0].n, rma: rma_.rows[0].n };
    });

    // ═══════════════════════════════════════════════════════════
    // ═══════════════════════════════════════════════════════════
    // v2.3 — EXCLUSÃO DE REGISTROS (somente admin, com auditoria)
    // ═══════════════════════════════════════════════════════════
    const ENTITY_TABLE = { ticket: 'tickets', complaint: 'complaints', return: 'returns', rma: 'rma' };
    const makeDeleteRoute = (etype, path) => {
      v1.delete(`/${path}/:id`, { preHandler: [authorize('admin')] }, async (req, reply) => {
        const table = ENTITY_TABLE[etype];
        const id = etype === 'ticket' ? String(req.params.id) : parseInt(req.params.id);
        if (etype !== 'ticket' && !Number.isInteger(id)) return send404(reply);
        const { rows:[row] } = await db.query(`SELECT * FROM ${table} WHERE id=$1`, [id]);
        if (!row) return send404(reply);
        // Conexão dedicada: SET LOCAL autoriza o cascade nas tabelas de
        // histórico append-only APENAS dentro desta transação (migration 014).
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          await client.query(`SET LOCAL app.admin_delete = 'on'`);
          await client.query(`DELETE FROM attachments WHERE entity_type=$1 AND entity_id=$2`, [etype, String(id)]);
          await client.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK').catch(() => {});
          if (e.code === '23503')
            return reply.code(409).send({ error:'HAS_LINKS', message:'Este registro tem vínculos ativos (ex.: RMA gerado a partir dele). Exclua primeiro o registro vinculado.', status:409 });
          throw e;
        } finally { client.release(); }
        await auditLog(req, 'delete', table, String(id), row, null);
        return { deleted: true, id };
      });
    };
    makeDeleteRoute('ticket', 'tickets');
    makeDeleteRoute('complaint', 'complaints');
    makeDeleteRoute('return', 'returns');
    makeDeleteRoute('rma', 'rma');

    // ═══════════════════════════════════════════════════════════
    // v2.2 — GOOGLE DRIVE: conexão OAuth e status
    // ═══════════════════════════════════════════════════════════
    const driveRedirectUri = (req) => {
      const base = (process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`).replace(/\/$/, '');
      return `${base}/api/v1/drive/oauth/callback`;
    };

    v1.get('/drive/status', { preHandler: [authenticate] }, async () => {
      const mode = driveMode();
      const connected = await driveConfigured();
      const root_link = mode === 'oauth' ? (await getSetting('drive_root_link')) : null;
      const account = mode === 'oauth' ? (await getSetting('drive_account_email')) : (process.env.GOOGLE_SA_EMAIL || null);
      return { mode, connected, root_link, account };
    });

    v1.get('/drive/oauth/url', { preHandler: [authorize('admin')] }, async (req, reply) => {
      if (driveMode() !== 'oauth')
        return reply.code(400).send({ error:'NOT_CONFIGURED', message:'Configure GOOGLE_OAUTH_CLIENT_ID e GOOGLE_OAUTH_CLIENT_SECRET no Railway primeiro.', status:400 });
      const state = jwt.sign({ purpose: 'drive_oauth' }, JWT_SECRET, { expiresIn: '15m' });
      const params = new URLSearchParams({
        client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri: driveRedirectUri(req),
        response_type: 'code',
        scope: 'https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      return { url: `https://accounts.google.com/o/oauth2/v2/auth?${params}`, redirect_uri: driveRedirectUri(req) };
    });

    v1.get('/drive/oauth/callback', async (req, reply) => {
      const { code, state, error } = req.query || {};
      const page = (title, msg, ok) => reply.type('text/html').send(
        `<!doctype html><meta charset="utf-8"><body style="font-family:Arial;background:#0f0f1a;color:#eee;display:flex;align-items:center;justify-content:center;height:100vh;margin:0">
         <div style="text-align:center;max-width:420px"><div style="font-size:42px">${ok ? '✅' : '⚠️'}</div>
         <h2>${title}</h2><p style="color:#aaa;font-size:14px">${msg}</p>
         <a href="/" style="color:#e94560;font-weight:bold">Voltar ao Hub</a></div></body>`);
      if (error) return page('Conexão cancelada', 'A autorização no Google foi cancelada. Tente novamente em Configurações → Integrações.', false);
      try { jwt.verify(state, JWT_SECRET); } catch { return page('Link expirado', 'O link de conexão expirou (15 min). Gere um novo em Configurações → Integrações.', false); }
      if (!code) return page('Código ausente', 'O Google não devolveu o código de autorização.', false);
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'authorization_code', code,
            client_id: process.env.GOOGLE_OAUTH_CLIENT_ID,
            client_secret: process.env.GOOGLE_OAUTH_CLIENT_SECRET,
            redirect_uri: driveRedirectUri(req),
          }),
          signal: AbortSignal.timeout(10000),
        });
        const d = await r.json();
        if (!r.ok || !d.refresh_token) throw new Error(d.error_description || d.error || `HTTP ${r.status} (sem refresh_token)`);
        await setSetting('drive_refresh_token', d.refresh_token);
        invalidateDriveToken();
        // Guarda o e-mail da conta conectada (informativo)
        try {
          const ui = await (await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${d.access_token}` }, signal: AbortSignal.timeout(8000),
          })).json();
          if (ui.email) await setSetting('drive_account_email', ui.email);
        } catch {}
        // Cria a pasta-raiz já na conexão, para o link aparecer no painel
        try { await driveRootFolder(); } catch (e) { console.error('drive root:', e.message); }
        return page('Google Drive conectado!', 'A partir de agora, todo anexo será espelhado automaticamente na pasta "Nextra CSO Hub — Atendimentos" do Drive.', true);
      } catch (e) {
        console.error('drive oauth callback:', e.message);
        return page('Falha na conexão', `Erro: ${e.message}. Verifique o Client ID/Secret e tente novamente.`, false);
      }
    });

    // v3.0: reespelha no Drive anexos enviados antes da conexão (lotes de 15)
    v1.post('/drive/remirror', { preHandler: [authorize('admin')] }, async (req, reply) => {
      if (!(await driveConfigured()))
        return reply.code(400).send({ error:'NOT_CONNECTED', message:'Conecte o Google Drive primeiro.', status:400 });
      const { rows } = await db.query(`SELECT id,entity_type,entity_id,filename,mime,data FROM attachments WHERE drive_url IS NULL ORDER BY id LIMIT 15`);
      let ok = 0, fail = 0;
      for (const a of rows) {
        const url = await driveMirror(a.entity_type, a.entity_id, a.filename, a.mime, a.data);
        if (url) { await db.query('UPDATE attachments SET drive_url=$1 WHERE id=$2', [url, a.id]).catch(()=>{}); ok++; }
        else fail++;
      }
      const { rows:[c] } = await db.query('SELECT COUNT(*)::int AS n FROM attachments WHERE drive_url IS NULL');
      return { mirrored: ok, failed: fail, remaining: c.n };
    });

    v1.post('/drive/disconnect', { preHandler: [authorize('admin')] }, async () => {
      await delSetting('drive_refresh_token');
      await delSetting('drive_root_folder_id');
      await delSetting('drive_root_link');
      await delSetting('drive_account_email');
      invalidateDriveToken();
      return { disconnected: true };
    });

    // v2.0 — DISPARO DE PESQUISA CSAT/NPS POR E-MAIL
    // ═══════════════════════════════════════════════════════════
    v1.post('/survey-links/:id/send', { preHandler: [authenticate] }, async (req, reply) => {
      const email = String(req.body?.email || '').trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'E-mail inválido.', status:400 });
      const { rows:[link] } = await db.query(
        `SELECT sl.*, c.name AS client_name FROM survey_links sl LEFT JOIN clients c ON c.id=sl.client_id WHERE sl.id=$1`, [req.params.id]);
      if (!link) return send404(reply);
      const base = process.env.PUBLIC_BASE_URL || `${req.protocol}://${req.headers.host}`;
      const url = `${base}/survey/${link.token}`;
      const isNps = link.survey_type === 'nps';
      const result = await sendEmail(email,
        isNps ? 'Nextra — Sua opinião vale muito (1 minuto)' : 'Nextra — Como foi seu atendimento?',
        `<div style="font-family:Arial,sans-serif;max-width:520px;margin:auto;padding:24px">
           <h2 style="color:#1a1a2e">Olá${link.client_name ? ', ' + link.client_name : ''}!</h2>
           <p>${isNps ? 'De 0 a 10, o quanto você recomendaria a Nextra?' : 'Queremos saber como foi sua experiência com nosso atendimento.'}</p>
           <p>Leva menos de 1 minuto:</p>
           <p style="text-align:center;margin:28px 0">
             <a href="${url}" style="background:#e94560;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:bold">Responder pesquisa</a>
           </p>
           <p style="font-size:12px;color:#888">Se o botão não funcionar, copie e cole este link: ${url}</p>
         </div>`);
      if (!result.sent) return reply.code(400).send({ error:'EMAIL_NOT_SENT', message: result.reason, status:400 });
      return { sent: true, to: email };
    });

    // v3.0.1: exclusão de link de pesquisa (admin) — limpeza de testes/disparos errados
    v1.delete('/survey-links/:id', { preHandler: [authorize('admin')] }, async (req, reply) => {
      const { rows:[l] } = await db.query('SELECT id,responded FROM survey_links WHERE id=$1', [req.params.id]);
      if (!l) return send404(reply);
      await db.query('DELETE FROM survey_links WHERE id=$1', [req.params.id]);
      await auditLog(req, 'delete', 'survey_links', String(req.params.id), l, null);
      return { deleted: true, aviso: l.responded ? 'O link foi removido; a resposta já registrada permanece nos indicadores.' : null };
    });

    // v3.2: backup sob demanda (admin). ?dry=1 só gera o dump e mede, sem subir.
    v1.post('/admin/backup', { preHandler: [authorize('admin')] }, async (req, reply) => {
      if (req.query?.dry === '1') {
        const { gz, tables, totalRows } = await buildDbDump();
        return { dry_run: true, tables, rows: totalRows, bytes: gz.length };
      }
      const r = await runBackup('manual');
      if (!r.ok) return reply.code(400).send({ error:'BACKUP_FAILED', message: r.reason, status:400 });
      return r;
    });
    v1.get('/admin/backup/status', { preHandler: [authorize('admin')] }, async () => ({
      last_at: await getSetting('backup_last_at'),
      last_link: await getSetting('backup_last_link'),
      last_bytes: parseInt(await getSetting('backup_last_bytes') || '0') || null,
    }));

    v1.post('/admin/wipe-demo-data', { preHandler: [authorize('admin')] }, async (req, reply) => {
      const { confirm } = req.body || {};
      if (confirm !== 'APAGAR')
        return reply.code(400).send({ error:'CONFIRMATION_REQUIRED', message:'Envie {"confirm":"APAGAR"} para confirmar. Esta ação é irreversível.', status:400 });
      const admin = getUser(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query('TRUNCATE TABLE clients, tickets RESTART IDENTITY CASCADE');
        await client.query('TRUNCATE TABLE suppliers RESTART IDENTITY CASCADE');
        await client.query('TRUNCATE TABLE audit_log RESTART IDENTITY CASCADE');
        await client.query('ALTER SEQUENCE ticket_seq RESTART WITH 1');
        await client.query('DELETE FROM users WHERE id != $1', [admin.sub]);
        await client.query(`SELECT setval('users_id_seq', (SELECT COALESCE(MAX(id),1) FROM users), true)`);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        return reply.code(500).send({ error:'WIPE_FAILED', message: e.message, status:500 });
      } finally {
        client.release();
      }
      return { message: 'Dados de demonstração/teste apagados com sucesso. Seu login foi preservado.' };
    });

    // ── TICKETS ────────────────────────────────────────────
    v1.get('/tickets', { preHandler: [authenticate] }, async (req) => {
      const { status, criticality, area_responsible, am_user_id, bdm_user_id, client_id, q, page='1', limit='100' } = req.query || {};
      const offset = (parseInt(page)-1)*parseInt(limit);
      const where = ['1=1']; const params = [];
      if (status)           { params.push(status);     where.push(`t.status=$${params.length}`); }
      if (criticality)      { params.push(criticality); where.push(`t.criticality=$${params.length}`); }
      if (area_responsible) { params.push(area_responsible); where.push(`t.area_responsible=$${params.length}`); }
      if (am_user_id)       { params.push(parseInt(am_user_id)); where.push(`t.am_user_id=$${params.length}`); }
      if (bdm_user_id)      { params.push(parseInt(bdm_user_id)); where.push(`t.bdm_user_id=$${params.length}`); }
      if (client_id)        { params.push(parseInt(client_id)); where.push(`t.client_id=$${params.length}`); }
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

    v1.get('/tickets/export/xlsx', { preHandler: [authenticate] }, async (req, reply) => {
      const { status, criticality, area_responsible, q } = req.query || {};
      const where = ['1=1']; const params = [];
      if (status)           { params.push(status);     where.push(`t.status=$${params.length}`); }
      if (criticality)      { params.push(criticality); where.push(`t.criticality=$${params.length}`); }
      if (area_responsible) { params.push(area_responsible); where.push(`t.area_responsible=$${params.length}`); }
      if (q) { params.push(`%${q}%`); where.push(`(t.client_name ILIKE $${params.length} OR t.id ILIKE $${params.length})`); }
      const { rows } = await db.query(
        `SELECT t.*, am.name AS am_name, bdm.name AS bdm_name FROM tickets t
         LEFT JOIN users am ON am.id=t.am_user_id LEFT JOIN users bdm ON bdm.id=t.bdm_user_id
         WHERE ${where.join(' AND ')} ORDER BY t.created_at DESC`,
        params
      );

      const workbook = new ExcelJS.Workbook();
      workbook.creator = 'Nextra CSO Hub';
      workbook.created = new Date();
      const sheet = workbook.addWorksheet('Chamados');
      sheet.columns = [
        { header: 'ID', key: 'id', width: 18 },
        { header: 'Cliente', key: 'client_name', width: 26 },
        { header: 'CNPJ', key: 'client_cnpj', width: 20 },
        { header: 'BU', key: 'business_unit_id', width: 8 },
        { header: 'Produto', key: 'product_name_snap', width: 22 },
        { header: 'Grupo', key: 'product_group', width: 16 },
        { header: 'Marca', key: 'brand', width: 14 },
        { header: 'Quantidade', key: 'quantity', width: 11 },
        { header: 'Nº Série', key: 'serial_number_snap', width: 16 },
        { header: 'Pedido', key: 'order_number', width: 16 },
        { header: 'NF', key: 'nf_number', width: 16 },
        { header: 'Valor do Pedido', key: 'order_value', width: 16 },
        { header: 'Receita em Risco', key: 'revenue_at_risk', width: 16 },
        { header: 'Tipo', key: 'occurrence_type', width: 18 },
        { header: 'Criticidade', key: 'criticality', width: 12 },
        { header: 'Status', key: 'status', width: 16 },
        { header: 'SLA', key: 'sla_state', width: 10 },
        { header: 'Área Responsável', key: 'area_responsible', width: 16 },
        { header: 'AM', key: 'am_name', width: 20 },
        { header: 'BDM', key: 'bdm_name', width: 20 },
        { header: 'Descrição', key: 'description', width: 40 },
        { header: 'Causa Raiz', key: 'root_cause_description', width: 30 },
        { header: 'Resolução', key: 'resolution', width: 30 },
        { header: 'Criado em', key: 'created_at', width: 18 },
        { header: 'Atualizado em', key: 'updated_at', width: 18 },
        { header: 'Encerrado em', key: 'closed_at', width: 18 },
      ];
      sheet.getRow(1).font = { bold: true };
      rows.forEach(r => sheet.addRow(r));
      sheet.columns.forEach(c => { if (['created_at','updated_at','closed_at'].includes(c.key)) c.numFmt = 'dd/mm/yyyy hh:mm'; });

      const buffer = await workbook.xlsx.writeBuffer();
      const dateStr = new Date().toISOString().slice(0,10);
      reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="chamados_${dateStr}.xlsx"`)
        .send(Buffer.from(buffer));
    });

    v1.post('/tickets', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.client_name || !d.description || d.description.length < 10)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'cliente e descrição (mín. 10 chars) obrigatórios.', status:400 });
      if (!d.nf_number || !String(d.nf_number).trim())
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota Fiscal (NF) é obrigatória.', status:400 });
      const qty = d.quantity !== undefined && d.quantity !== null && d.quantity !== '' ? Number(d.quantity) : 1;
      if (!Number.isInteger(qty) || qty <= 0)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Quantidade deve ser um número inteiro maior que zero.', status:400 });
      const user = getUser(req);
      const { rows: [{nextval}] } = await db.query("SELECT nextval('ticket_seq') AS nextval");
      const ticketId = `CSO-${new Date().toISOString().slice(0,10).replace(/-/g,'')}-${String(nextval).padStart(4,'0')}`;
      const slaHours = { critical:8, high:24, medium:48, low:96 }[d.criticality||'medium']||48;
      const slaDeadline = await computeSlaDeadline(slaHours); // v2.0: horas ÚTEIS (business_hours + holidays)
      const notifyAreas = Array.isArray(d.notify_areas) ? d.notify_areas : (typeof d.notify_areas==='string' && d.notify_areas ? d.notify_areas.split(',').filter(Boolean) : []);
      try {
        const { rows:[ticket] } = await db.query(`
          INSERT INTO tickets (id, business_unit_id, client_id, client_name, client_cnpj, created_by_user_id,
            am_user_id, bdm_user_id, channel, occurrence_type, criticality, area_responsible, notify_areas,
            description, expectation, previous_action,
            order_number, nf_number, order_value, revenue_at_risk,
            product_name_snap, serial_number_snap, quantity, product_group, brand,
            is_vip, is_recurrence,
            contact_name, contact_email,
            sla_deadline, sla_state, status, approval_status, reopen_count)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::user_role[],$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$29,$30,$28,'ok','new','pending',0)
          RETURNING *`,
          [ticketId, d.business_unit_id||'led', d.client_id||null, d.client_name, d.cnpj||null, user.sub,
           d.am_user_id||null, d.bdm_user_id||null,
           d.channel||'whatsapp', d.occurrence_type||'technical_support',
           d.criticality||'medium', d.area_responsible||'support', notifyAreas,
           d.description, d.expectation||null, d.previous_action||null,
           d.order_number||null, String(d.nf_number).trim(), d.order_value||null, d.revenue_at_risk||0,
           d.product||null, d.serial_number||null, qty, d.product_group||null, d.brand||null,
           d.is_vip||false, d.is_recurrence||false, slaDeadline.toISOString(),
           d.contact_name||null, (d.contact_email||'').trim()||null]
        );
        await db.query(`INSERT INTO ticket_history (ticket_id,user_id,action) VALUES ($1,$2,'ticket_aberto')`, [ticketId, user.sub]);
        // v3.0: e-mail de ação para as áreas acionadas + acompanhamento ao AM/BDM
        const areasAcionadas = [...new Set([ticket.area_responsible, ...(notifyAreas||[])])].filter(Boolean);
        emailAreas(ticket, areasAcionadas, 'Novo chamado aberto', req).catch(()=>{});
        emailAmBdm(ticket, 'Novo chamado criado para seu cliente', [['Status','Novo'],['Aberto por', user.name]], req).catch(()=>{});
        await auditLog(req, 'create', 'tickets', ticketId, null, ticket);
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
      if (t.status === 'closed')
        return reply.code(409).send({ error:'TICKET_CLOSED', message:'Chamado encerrado não pode ser editado. Reabra o chamado primeiro.', status:409 });
      const d = req.body || {};
      const allowed = ['root_cause_category','root_cause_description','resolution','preventive_action',
        'area_responsible','resp_user_id','am_user_id','bdm_user_id','manager_user_id',
        'revenue_at_risk','order_number','order_value','nf_number','contact_name','contact_email',
        'client_name','client_cnpj','expectation','previous_action','product_name_snap','serial_number_snap',
        'quantity','product_group','brand','description','criticality'];
      // NF: se enviada, não pode ser vazia/espaços (obrigatória o tempo todo, inclusive na edição).
      if ('nf_number' in d && !String(d.nf_number||'').trim())
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nota Fiscal (NF) não pode ficar vazia.', status:400 });
      // Quantidade: se enviada, precisa ser inteiro > 0.
      if ('quantity' in d) {
        const q = Number(d.quantity);
        if (!Number.isInteger(q) || q <= 0)
          return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Quantidade deve ser um número inteiro maior que zero.', status:400 });
        d.quantity = q;
      }
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) return t;
      const set = fields.map(([k],i)=>`${k}=$${i+2}${k==='area_responsible'?'::user_role':k==='criticality'?'::criticality_level':''}`).join(', ');
      const user = getUser(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows:[u] } = await client.query(
          `UPDATE tickets SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING *`,
          [id, ...fields.map(([,v])=>v)]
        );
        // Histórico: uma linha por campo alterado, registrando valor antigo/novo, usuário e data.
        for (const [k] of fields) {
          const oldVal = t[k] === null || t[k] === undefined ? null : String(t[k]);
          const newVal = u[k] === null || u[k] === undefined ? null : String(u[k]);
          if (oldVal !== newVal) {
            await client.query(
              `INSERT INTO ticket_history (ticket_id,user_id,action,field_changed,old_value,new_value) VALUES ($1,$2,'edicao',$3,$4,$5)`,
              [id, user.sub, k, oldVal, newVal]
            );
          }
        }
        await client.query('COMMIT');
        await auditLog(req, 'update', 'tickets', id, t, u);
        return withIgnored(u, d, allowed);
      } catch(e) {
        await client.query('ROLLBACK').catch(()=>{});
        return reply.code(400).send({ error:'UPDATE_FAILED', message:e.message, status:400 });
      } finally {
        client.release();
      }
    });

    v1.patch('/tickets/:id/notify-areas', { preHandler: [authenticate] }, async (req, reply) => {
      const areas = Array.isArray(req.body?.notify_areas) ? req.body.notify_areas : [];
      const { rows:[antes] } = await db.query('SELECT notify_areas FROM tickets WHERE id=$1', [req.params.id]);
      const { rows:[u] } = await db.query(`UPDATE tickets SET notify_areas=$2::user_role[], updated_at=NOW() WHERE id=$1 RETURNING *`, [req.params.id, areas]);
      if (!u) return send404(reply);
      // v3.0: e-mail de ação apenas para áreas que ENTRARAM agora (quem já sabia não recebe de novo)
      const novas = areas.filter(a => !(antes?.notify_areas||[]).includes(a));
      if (novas.length) emailAreas(u, novas, 'Área acionada em chamado existente', req).catch(()=>{});
      return u;
    });


    v1.patch('/tickets/:id/status', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const { status: newStatus, note } = req.body || {};
      const { rows:[t] } = await db.query('SELECT * FROM tickets WHERE id=$1', [id]);
      if (!t) return send404(reply);
      const user = getUser(req);
      if (user.role === 'board') return reply.code(403).send({ error:'BOARD_READ_ONLY', status:403 });
      if (newStatus && newStatus !== t.status) {
        const allowedNext = TICKET_STATUS_TRANSITIONS[t.status] || [];
        if (!allowedNext.includes(newStatus)) {
          return reply.code(409).send({
            error: 'INVALID_TRANSITION',
            message: `Transição inválida: ${t.status} → ${newStatus}. Transições permitidas a partir de "${t.status}": ${allowedNext.join(', ') || 'nenhuma'}.`,
            status: 409,
          });
        }
      }
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
      // v3.0: acompanhamento ao AM/BDM a cada movimento no kanban
      if (newStatus && newStatus !== t.status) {
        const titulo = newStatus === 'closed' ? 'Chamado encerrado' : `Chamado avançou: ${TICKET_STATUS_LABEL_SRV[newStatus]||newStatus}`;
        emailAmBdm(u, titulo, [
          ['Movimento', `${TICKET_STATUS_LABEL_SRV[t.status]||t.status} → ${TICKET_STATUS_LABEL_SRV[newStatus]||newStatus}`],
          ['Por', user.name], note ? ['Observação', String(note).slice(0,200)] : null,
          newStatus === 'closed' ? ['Resolução', String(u.resolution||'').slice(0,250)] : null,
        ].filter(Boolean), req).catch(()=>{});
      }
      // v3.0: CSAT automático no encerramento — cria o link e envia ao cliente (se tiver e-mail)
      if (newStatus === 'closed' && u.client_id) {
        (async () => {
          try {
            const { rows:[cli] } = await db.query('SELECT id,name,email FROM clients WHERE id=$1', [u.client_id]);
            const destino = (u.contact_email || '').trim() || cli?.email;
            if (!destino) return;
            // v3.1: cooldown — o mesmo cliente não recebe pesquisa automática 2x em 30 dias
            const { rows:[cd] } = await db.query(
              `SELECT COUNT(*)::int AS n FROM survey_links WHERE client_id=$1 AND created_at > NOW() - INTERVAL '30 days'`, [cli.id]);
            if (cd.n > 0) return;
            const stoken = crypto.randomBytes(20).toString('hex');
            await db.query(`INSERT INTO survey_links (token,survey_type,client_id,business_unit_id,ticket_id,created_by)
              VALUES ($1,'csat',$2,$3,$4,$5)`, [stoken, cli.id, u.business_unit_id||'led', u.id, user.sub]);
            const surl = `${hubUrl(req)}/survey/${stoken}`;
            await sendEmail(destino, `Nextra — Como foi o atendimento do chamado ${u.id}?`,
              emailTemplate('Seu atendimento foi encerrado. Como foi a experiência?',
                [['Chamado', u.id], ['Cliente', cli.name]], surl).replace('Abrir no Hub','Responder pesquisa (1 min)'));
          } catch (e) { console.error('autoCsat:', e.message); }
        })();
      }
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
      const buErr = await assertBU(d.business_unit_id); if (buErr) return reply.code(422).send({ error:'VALIDATION_ERROR', message:buErr, status:422 });
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
      const buErr = await assertBU(d.business_unit_id); if (buErr) return reply.code(422).send({ error:'VALIDATION_ERROR', message:buErr, status:422 });
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
        'difal_cost','cost_status','decision_notes',
        'inspection_status','inspection_date','inspection_technician_user_id',
        'inspection_third_party_company','inspection_physical_condition',
        'inspection_functional_result','inspection_report','available_for_resale'];
      const fields = Object.entries(d).filter(([k])=>allowed.includes(k) && v_defined(d[k]));
      if (!fields.length) return r;
      const set = fields.map(([k],i)=>`${k}=$${i+2}${k==='inspection_status'?'::inspection_result':''}`).join(', ');
      try {
        const { rows:[u] } = await db.query(`UPDATE returns SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, ...fields.map(([,v])=>v)]);
        await db.query(`INSERT INTO return_history (return_id,user_id,action,note) VALUES ($1,$2,'análise de causa / custo atualizada',$3)`,
          [req.params.id, getUser(req).sub, d.root_cause_notes||d.reduction_action||null]);
        return withIgnored(u, d, allowed);
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

    // ── DEVOLUÇÃO → INSPEÇÃO → RMA (transacional) ───────────
    // Cria um RMA vinculado a esta Devolução e só encerra a Devolução se o
    // RMA for criado com sucesso, tudo dentro de uma única transação de
    // banco. Se o RMA falhar por qualquer motivo, a Devolução permanece
    // aberta exatamente como estava (ROLLBACK integral).
    v1.post('/returns/:id/create-rma', { preHandler: [authenticate] }, async (req, reply) => {
      const { id } = req.params;
      const user = getUser(req);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const { rows:[r] } = await client.query('SELECT * FROM returns WHERE id=$1 FOR UPDATE', [id]);
        if (!r) { await client.query('ROLLBACK'); return send404(reply); }

        if (r.status !== 'under_inspection') {
          await client.query('ROLLBACK');
          return reply.code(422).send({ error:'INVALID_STATE', message:`A Devolução precisa estar em "Em Inspeção" para abrir um RMA (status atual: ${r.status}).`, status:422 });
        }
        if (r.inspection_status !== 'rejected_defect') {
          await client.query('ROLLBACK');
          return reply.code(422).send({ error:'INSPECTION_NOT_REJECTED', message:'Só é possível abrir RMA quando a inspeção reprovou o produto por defeito.', status:422 });
        }
        if (!r.inspection_report || !r.inspection_report.trim()) {
          await client.query('ROLLBACK');
          return reply.code(422).send({ error:'MISSING_REPORT', message:'Laudo técnico é obrigatório para abrir o RMA.', status:422 });
        }
        if (r.linked_rma_id) {
          await client.query('ROLLBACK');
          return reply.code(409).send({ error:'RMA_ALREADY_LINKED', message:'Esta Devolução já possui um RMA vinculado.', status:409 });
        }

        // Herda os dados da Devolução para o novo RMA.
        const { rows:[rma] } = await client.query(`
          INSERT INTO rma (client_id, business_unit_id, ticket_id, product_name, product_code, serial_number,
            defect_description, warranty, unit_cost, responsible_user_id, created_by_user_id, return_id, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'requested')
          RETURNING *`,
          [r.client_id, r.business_unit_id, r.ticket_id, r.product_name_snap || 'Produto de devolução',
           null, null, r.inspection_report, false, r.total_value || r.unit_value || null,
           r.responsible_user_id, user.sub, r.id]
        );

        await client.query(
          `UPDATE returns SET linked_rma_id=$2, status='replacement_sent'::return_status, updated_at=NOW() WHERE id=$1`,
          [id, rma.id]
        );
        await client.query(
          `UPDATE returns SET status='closed'::return_status, closed_at=NOW(), updated_at=NOW() WHERE id=$1`,
          [id]
        );

        await client.query(
          `INSERT INTO return_history (return_id,user_id,action,old_status,new_status,note) VALUES ($1,$2,'rma_criado_e_devolucao_encerrada',$3,'closed',$4)`,
          [id, user.sub, r.status, `RMA #${rma.id} criado a partir desta devolução.`]
        );
        await client.query(
          `INSERT INTO rma_history (rma_id,user_id,action,note) VALUES ($1,$2,'rma_criado_via_devolucao',$3)`,
          [rma.id, user.sub, `Criado a partir da Devolução #${id}.`]
        );

        await client.query('COMMIT');
        await auditLog(req, 'create', 'rma', rma.id, null, rma);
        return reply.code(201).send({ rma, message: `RMA #${rma.id} criado e Devolução #${id} encerrada.` });
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        // A Devolução permanece exatamente como estava — nenhuma alteração parcial é possível.
        return reply.code(400).send({ error:'RMA_CREATION_FAILED', message: `Não foi possível criar o RMA — a Devolução continua aberta. Detalhe: ${e.message}`, status:400 });
      } finally {
        client.release();
      }
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
           (SELECT COUNT(*)::int FROM rma r2 WHERE r2.id!=r.id AND (
              (r.product_id IS NOT NULL AND r2.product_id=r.product_id)
              OR (r.product_id IS NULL AND COALESCE(r2.product_code,r2.product_name)=COALESCE(r.product_code,r.product_name))
            )) AS recurrence_count
         FROM rma r
         LEFT JOIN clients cl ON cl.id=r.client_id
         LEFT JOIN suppliers sp ON sp.id=r.supplier_id
         WHERE ${where.join(' AND ')} ORDER BY r.created_at DESC`, params);
      return { data: rows.map(r => ({ ...r, is_recurrence: r.recurrence_count > 0 })) };
    });

    v1.post('/rma', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.product_name || !d.defect_description) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'product_name e defect_description obrigatórios.', status:400 });
      const buErr = await assertBU(d.business_unit_id); if (buErr) return reply.code(422).send({ error:'VALIDATION_ERROR', message:buErr, status:422 });
      const user = getUser(req);
      try {
        // v2.0: garantia calculada a partir do catálogo (warranty_months) + data de compra
        const prodId = d.product_id ? parseInt(d.product_id) : null;
        let warrantyState = null, supplierFromCatalog = null;
        if (prodId) {
          const { rows: [p] } = await db.query(`SELECT warranty_months, supplier_id FROM product_catalog WHERE id=$1`, [prodId]);
          if (p) {
            supplierFromCatalog = p.supplier_id;
            if (d.purchase_date) {
              const exp = new Date(d.purchase_date);
              exp.setMonth(exp.getMonth() + (p.warranty_months || 12));
              warrantyState = exp >= new Date() ? 'in_warranty' : 'out_of_warranty';
            }
          }
        }
        const { rows:[r] } = await db.query(`
          INSERT INTO rma (client_id,business_unit_id,ticket_id,product_name,product_code,
            serial_number,defect_description,warranty,unit_cost,supplier_id,responsible_user_id,created_by_user_id,
            product_id,purchase_date,warranty_state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [d.client_id||null,d.business_unit_id||'led',d.ticket_id||null,d.product_name,
           d.product_code||null,d.serial_number||null,d.defect_description,
           d.warranty !== undefined ? d.warranty : (warrantyState === 'in_warranty'),
           d.unit_cost||null,d.supplier_id||supplierFromCatalog||null,d.responsible_user_id||user.sub,user.sub,
           prodId, d.purchase_date||null, warrantyState]);
        await db.query(`INSERT INTO rma_history (rma_id,user_id,action,new_status) VALUES ($1,$2,'rma_criado','requested')`,
          [r.id, user.sub]);
        // Detecta recorrência: por product_id (dado limpo) com fallback para código/nome
        const { rows: rec } = prodId
          ? await db.query(`SELECT COUNT(*)::int AS cnt FROM rma WHERE product_id=$1 AND id != $2`, [prodId, r.id])
          : await db.query(
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
      const { rows: rec } = rma.product_id
        ? await db.query(`SELECT id,status,created_at FROM rma WHERE product_id=$1 AND id != $2 ORDER BY created_at DESC`, [rma.product_id, rma.id])
        : await db.query(
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
      if (!fields.length) { const {rows:[r]}=await db.query('SELECT * FROM rma WHERE id=$1',[req.params.id]); return r ? withIgnored(r, d, allowed) : send404(reply); }
      const set = fields.map(([k],i)=>`${k}=$${i+2}`).join(', ');
      try {
        const { rows:[u] } = await db.query(`UPDATE rma SET ${set},updated_at=NOW() WHERE id=$1 RETURNING *`,
          [req.params.id, ...fields.map(([,v])=>v)]);
        if (!u) return send404(reply);
        if (d.outcome_type) {
          await db.query(`INSERT INTO rma_history (rma_id,user_id,action,note) VALUES ($1,$2,'desfecho registrado',$3)`,
            [req.params.id, getUser(req).sub, d.outcome_type]);
        }
        return withIgnored(u, d, allowed);
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

    v1.post('/clients', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      if (!d.name || !d.name.trim())
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nome do cliente é obrigatório.', status:400 });
      const buErr = await assertBU(d.primary_bu); if (buErr) return reply.code(422).send({ error:'VALIDATION_ERROR', message:buErr, status:422 });
      if (d.cnpj) {
        const digits = String(d.cnpj).replace(/\D/g,'');
        if (digits.length !== 14)
          return reply.code(400).send({ error:'VALIDATION_ERROR', message:'CNPJ deve ter 14 dígitos.', status:400 });
        if (!isValidCNPJSrv(digits))
          return reply.code(400).send({ error:'VALIDATION_ERROR', message:'CNPJ inválido (dígito verificador não confere).', status:400 });
        const { rows: dup } = await db.query('SELECT id,name FROM clients WHERE cnpj=$1', [d.cnpj]);
        if (dup.length) return reply.code(409).send({ error:'CNPJ_TAKEN', message:`CNPJ já cadastrado para o cliente "${dup[0].name}".`, status:409 });
      }
      const { rows:[c] } = await db.query(`
        INSERT INTO clients (name,cnpj,city,state,segment,is_vip,primary_bu,account_manager_id,bdm_id,phone,email,notes)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [d.name.trim(), d.cnpj||null, d.city||null, d.state||null, d.segment||null,
         d.is_vip||false, d.primary_bu||null, d.account_manager_id||null, d.bdm_id||null,
         d.phone||null, d.email||null, d.notes||null]);
      return reply.code(201).send(c);
    });

    v1.patch('/clients/:id', { preHandler: [authenticate] }, async (req, reply) => {
      const d = req.body || {};
      const allowed = ['name','cnpj','city','state','segment','is_vip','primary_bu','account_manager_id','bdm_id','phone','email','notes','is_active'];
      const fields = Object.entries(d).filter(([k]) => allowed.includes(k));
      if (!fields.length) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Nenhum campo válido.', status:400 });
      if (d.cnpj) {
        const digits = String(d.cnpj).replace(/\D/g,'');
        if (digits.length !== 14)
          return reply.code(400).send({ error:'VALIDATION_ERROR', message:'CNPJ deve ter 14 dígitos.', status:400 });
        if (!isValidCNPJSrv(digits))
          return reply.code(400).send({ error:'VALIDATION_ERROR', message:'CNPJ inválido (dígito verificador não confere).', status:400 });
        const { rows: dup } = await db.query('SELECT id,name FROM clients WHERE cnpj=$1 AND id!=$2', [d.cnpj, req.params.id]);
        if (dup.length) return reply.code(409).send({ error:'CNPJ_TAKEN', message:`CNPJ já cadastrado para o cliente "${dup[0].name}".`, status:409 });
      }
      const set = fields.map(([k],i) => `${k}=$${i+2}`).join(', ');
      const { rows:[c] } = await db.query(
        `UPDATE clients SET ${set}, updated_at=NOW() WHERE id=$1 RETURNING *`,
        [req.params.id, ...fields.map(([,v]) => v)]);
      if (!c) return send404(reply);
      return withIgnored(c, req.body, allowed);
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
      await refreshClientCsat(d.client_id);
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
      // v3.1: aviso de cooldown no disparo manual (permite, mas informa)
      const { rows:[cd] } = await db.query(
        `SELECT COUNT(*)::int AS n FROM survey_links WHERE client_id=$1 AND id<>$2 AND created_at > NOW() - INTERVAL '30 days'`, [d.client_id, link.id]);
      const aviso_cooldown = cd.n > 0 ? 'Atenção: este cliente já recebeu pesquisa nos últimos 30 dias. Excesso de pesquisa derruba a taxa de resposta.' : null;
      return reply.code(201).send({ ...link, survey_url: `${base}/survey/${token}`, aviso_cooldown });
    });

    // v3.1: relatório de motivos — onde dói e o que encanta, por volume
    v1.get('/surveys/reports/reasons', { preHandler: [authenticate] }, async () => {
      const safe = (p) => p.catch(() => ({ rows: [] }));
      const [csatR, npsR, byArea] = await Promise.all([
        safe(db.query(`SELECT unnest(reasons) AS reason, CASE WHEN score<=3 THEN 'negativo' ELSE 'positivo' END AS band, COUNT(*)::int AS n
          FROM csat WHERE reasons IS NOT NULL GROUP BY 1,2 ORDER BY n DESC`)),
        safe(db.query(`SELECT unnest(reasons) AS reason, CASE WHEN score<=6 THEN 'detrator' WHEN score<=8 THEN 'neutro' ELSE 'promotor' END AS band, COUNT(*)::int AS n
          FROM nps WHERE reasons IS NOT NULL GROUP BY 1,2 ORDER BY n DESC`)),
        safe(db.query(`SELECT t.area_responsible AS area, unnest(c.reasons) AS reason, COUNT(*)::int AS n
          FROM csat c JOIN tickets t ON t.id=c.ticket_id WHERE c.reasons IS NOT NULL AND c.score<=3
          GROUP BY 1,2 ORDER BY n DESC LIMIT 20`)),
      ]);
      return { csat: csatR.rows, nps: npsR.rows, csat_negativos_por_area: byArea.rows };
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
        // v3.1: motivos estruturados (chips) — no máximo 10, saneados
        const reasons = Array.isArray(req.body?.reasons)
          ? req.body.reasons.filter(x => typeof x === 'string' && x.trim()).map(x => String(x).trim().slice(0, 60)).slice(0, 10)
          : [];
        if (link.survey_type === 'csat') {
          await db.query(`INSERT INTO csat (client_id,business_unit_id,ticket_id,complaint_id,score,comment,reasons,collection_date) VALUES ($1,$2,$3,$4,$5,$6,$7,CURRENT_DATE)`,
            [link.client_id, link.business_unit_id, link.ticket_id, link.complaint_id, score, comment||null, reasons.length?reasons:null]);
        } else {
          await db.query(`INSERT INTO nps (client_id,business_unit_id,score,comment,reasons,collection_date) VALUES ($1,$2,$3,$4,$5,CURRENT_DATE)`,
            [link.client_id, link.business_unit_id, score, comment||null, reasons.length?reasons:null]);
        }
        // v3.1: detrator dispara reação — alerta na Torre/sino + e-mail, com os motivos anexados
        const isDetractor = (link.survey_type === 'csat' && score <= 2) || (link.survey_type === 'nps' && score <= 6);
        if (isDetractor) {
          (async () => {
            try {
              const { rows:[cli] } = await db.query('SELECT id,name,account_manager_id FROM clients WHERE id=$1', [link.client_id]);
              const motivos = reasons.length ? ` Motivos: ${reasons.join(', ')}.` : '';
              const msg = `🚨 DETRATOR: ${cli?.name || 'Cliente'} respondeu ${link.survey_type.toUpperCase()} nota ${score}.${motivos} Sugerido: Plano de Recuperação.`;
              await notifyUsers([cli?.account_manager_id], 'detractor_alert', msg, link.ticket_id, 'recovery');
              await notifyAdmins('detractor_alert', msg, link.ticket_id, 'recovery');
              const html = emailTemplate('🚨 Alerta de detrator', [
                ['Cliente', cli?.name], ['Pesquisa', link.survey_type.toUpperCase()], ['Nota', String(score)],
                reasons.length ? ['Motivos', reasons.join(', ')] : null,
                comment ? ['Comentário', String(comment).slice(0, 250)] : null,
                ['Ação sugerida', 'Abrir Plano de Recuperação'],
              ].filter(Boolean), hubUrl(null));
              emailUsersByIds([cli?.account_manager_id], `[ALERTA] Detrator — ${cli?.name}`, html).catch(()=>{});
              emailUsersByRoles(['admin'], `[ALERTA] Detrator — ${cli?.name}`, html).catch(()=>{});
            } catch (e) { console.error('detractorAlert:', e.message); }
          })();
        }
        await db.query('UPDATE survey_links SET responded=TRUE, responded_at=NOW() WHERE id=$1', [link.id]);
        if (link.survey_type === 'csat') await refreshClientCsat(link.client_id);
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
    // Helper compartilhado: chama a API da Anthropic com timeout real e
    // modelo configurável via env var — nunca hardcoded no código.
    async function callAnthropic(prompt, maxTokens) {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) { const e = new Error('AI_NOT_CONFIGURED'); e.code = 'AI_NOT_CONFIGURED'; throw e; }
      const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
      const timeoutMs = parseInt(process.env.AI_TIMEOUT_MS || '15000');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method:'POST', headers:{'Content-Type':'application/json','x-api-key':apiKey,'anthropic-version':'2023-06-01'},
          body: JSON.stringify({ model, max_tokens: maxTokens, messages:[{role:'user',content:prompt}] }),
          signal: controller.signal,
        });
        const d = await r.json();
        if (!r.ok) { const e = new Error(d.error?.message || 'Erro na API de IA.'); e.code = 'AI_ERROR'; throw e; }
        const txt = (d.content||[]).filter(b=>b.type==='text').map(b=>b.text).join('').replace(/```json|```/g,'').trim();
        let parsed;
        try { parsed = JSON.parse(txt); }
        catch { const e = new Error('A IA retornou uma resposta que não é um JSON válido.'); e.code = 'AI_INVALID_RESPONSE'; throw e; }
        return parsed;
      } catch (e) {
        if (e.name === 'AbortError') { const te = new Error(`Tempo limite de ${timeoutMs}ms excedido ao chamar a IA.`); te.code = 'AI_TIMEOUT'; throw te; }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    function aiErrorReply(reply, e) {
      if (e.code === 'AI_NOT_CONFIGURED') return reply.code(503).send({ error:'AI_UNAVAILABLE', message:'Recurso de IA não configurado. Peça ao administrador para configurar ANTHROPIC_API_KEY nas variáveis do Railway.', status:503 });
      if (e.code === 'AI_TIMEOUT') return reply.code(504).send({ error:'AI_TIMEOUT', message:e.message, status:504 });
      if (e.code === 'AI_INVALID_RESPONSE') return reply.code(502).send({ error:'AI_INVALID_RESPONSE', message:e.message, status:502 });
      return reply.code(502).send({ error: e.code || 'AI_ERROR', message: e.message, status:502 });
    }

    // Informa ao frontend, sem expor a chave, se a IA está disponível —
    // usado para mostrar um aviso claro na interface quando não configurada.
    v1.get('/ai/status', { preHandler: [authenticate] }, async () => {
      return { configured: !!process.env.ANTHROPIC_API_KEY, model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' };
    });

    v1.post('/ai/recovery-plan', { preHandler: [authenticate] }, async (req, reply) => {
      const { client_id } = req.body || {};
      if (!client_id) return reply.code(400).send({ error:'VALIDATION_ERROR', message:'client_id obrigatório.', status:400 });
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
        const result = await callAnthropic(prompt, 1000);
        // Validação de tipos/valores retornados — nunca confia cegamente no JSON da IA.
        if (typeof result.diagnosis !== 'string' || !Array.isArray(result.actions) || !result.actions.length) {
          return reply.code(502).send({ error:'AI_INVALID_RESPONSE', message:'A IA retornou uma estrutura inesperada (faltam diagnosis/actions).', status:502 });
        }
        result.target_score = Math.min(100, Math.max(0, parseInt(result.target_score) || 70));
        result.actions = result.actions.filter(a => a && typeof a.description === 'string' && a.description.trim());
        // Nunca grava nada no banco automaticamente — apenas devolve a sugestão.
        // A criação do Plano de Recuperação exige confirmação humana explícita
        // via POST /recovery-plans, feita pelo usuário no frontend.
        return { success:true, result };
      } catch(e) { return aiErrorReply(reply, e); }
    });

    // ── AI TRIAGE ─────────────────────────────────────────
    v1.post('/ai/triage', { preHandler: [authenticate] }, async (req, reply) => {
      const { client_name, business_unit_id, product, description, expectation, previous_action } = req.body || {};
      if (!description || description.length < 10)
        return reply.code(400).send({ error:'VALIDATION_ERROR', message:'Descrição obrigatória (mín. 10 chars).' });
      const TYPES = ['technical_support','complaint','rma','operational_problem','delivery_problem','incomplete_order','warranty','exchange_return','billing_issue','other'];
      const CRITICALITIES = ['critical','high','medium','low'];
      const AREAS = ['support','operations','sales','purchasing','warehouse','fiscal','rma','financial'];
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
        const result = await callAnthropic(prompt, 900);
        // Validação estrita: se a IA sugerir um tipo/criticidade/área fora do
        // vocabulário conhecido do sistema, cai para um valor seguro em vez
        // de propagar lixo para o banco.
        if (!TYPES.includes(result.occurrence_type)) result.occurrence_type = 'other';
        if (!CRITICALITIES.includes(result.criticality)) result.criticality = 'medium';
        result.notify_areas = Array.isArray(result.notify_areas) ? result.notify_areas.filter(a => AREAS.includes(a)) : [];
        // A IA apenas sugere — quem abre o chamado com esses valores pré-
        // preenchidos é o usuário, revisando e confirmando manualmente.
        return { success:true, result };
      } catch(e) { return aiErrorReply(reply, e); }
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
          db.query(`SELECT id,client_name,status,criticality,sla_state,description,sla_deadline FROM tickets WHERE status NOT IN ('closed','resolved') AND sla_state NOT IN ('done','paused') AND sla_deadline < NOW() ORDER BY sla_deadline LIMIT 20`),
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
    // Respeita o status code de erros conhecidos do próprio Fastify (ex: JSON
    // malformado, corpo vazio, payload grande demais) em vez de mascarar tudo
    // como 500 — mas nunca expõe stack trace ou detalhes internos ao cliente.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return reply.code(err.statusCode).send({ error: err.code || 'BAD_REQUEST', message: err.message, status: err.statusCode });
    }
    reply.code(500).send({ error:'INTERNAL_ERROR', message:'Erro interno do servidor.', status:500 });
  });

  // v2.0: varredura de SLA — no boot e a cada 5 minutos
  if (process.env.NODE_ENV !== 'test') {
    slaSweep();
    setInterval(slaSweep, 5 * 60 * 1000).unref();
    setInterval(backupScheduler, 30 * 60 * 1000).unref(); // v3.2: backup diário 03:00 BRT
    setTimeout(backupScheduler, 90 * 1000).unref();       // primeira checagem logo após o boot
  }

  return app;
}

// ── Start server ────────────────────────────────────────────────
const port = parseInt(process.env.PORT || '3001');
const host = process.env.HOST || '0.0.0.0';

if (require.main === module) {
  buildApp().then(async (app) => {
    await app.listen({ port, host });
    console.log(`🚀 Nextra CSO Hub rodando em http://${host}:${port}`);
    console.log(`   /health  →  http://${host}:${port}/health\n`);
  }).catch(err => {
    console.error('Falha ao iniciar:', err);
    process.exit(1);
  });
}

module.exports = { buildApp };
