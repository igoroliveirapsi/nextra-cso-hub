import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import Redis from 'ioredis';
import fs from 'fs';
import path from 'path';

import { db } from './db/client.js';
import { authRoutes } from './routes/auth.js';
import { ticketRoutes } from './routes/tickets.js';
import { userRoutes, configRoutes } from './routes/users.js';
import { complaintRoutes } from './routes/complaints.js';
import { returnsRoutes } from './routes/returns.js';
import { rmaRoutes } from './routes/rma.js';
import { clientRoutes } from './routes/clients.js';
import { csatRoutes, npsRoutes, recoveryRoutes } from './routes/csat-nps-recovery.js';
import { dashboardRoutes } from './routes/dashboard.js';

declare module 'fastify' {
  interface FastifyInstance {
    db: typeof db;
    redis: Redis | null;
  }
}

export async function buildApp() {
  const isProd = process.env.NODE_ENV === 'production';

  const app = Fastify({
    logger: {
      level: isProd ? 'warn' : 'info',
      ...(isProd ? {} : {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard' },
        },
      }),
    },
    trustProxy: true,
  });

  // ── Helmet (security headers) ─────────────────────────────
  await app.register(helmet, { contentSecurityPolicy: false });

  // ── CORS ──────────────────────────────────────────────────
  await app.register(cors, {
    origin: isProd
      ? (process.env.ALLOWED_ORIGINS ?? '').split(',').filter(Boolean)
      : true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: true,
  });

  // ── Redis (optional — JWT blacklist disabled if unavailable) ─
  let redisClient: Redis | null = null;
  if (process.env.REDIS_URL) {
    try {
      redisClient = new Redis(process.env.REDIS_URL, {
        lazyConnect: true,
        maxRetriesPerRequest: 2,
        connectTimeout: 3_000,
      });
      await redisClient.connect();
      app.log.info('Redis connected');
    } catch (err) {
      app.log.warn({ err }, 'Redis unavailable — JWT blacklist disabled');
      redisClient = null;
    }
  }
  app.decorate('redis', redisClient);

  // ── Rate limiting ─────────────────────────────────────────
  await app.register(rateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX ?? '100'),
    timeWindow: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? '60000'),
    errorResponseBuilder: () => ({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Limite de requisições atingido. Tente novamente em 1 minuto.',
      status: 429,
    }),
  });

  // ── DB ────────────────────────────────────────────────────
  app.decorate('db', db);

  // ── Health ────────────────────────────────────────────────
  app.get('/health', async () => {
    const dbOk = await db.healthCheck();
    const redisOk = redisClient ? await redisClient.ping().then(() => true).catch(() => false) : null;
    return {
      status: dbOk ? 'ok' : 'degraded',
      db: dbOk ? 'ok' : 'error',
      redis: redisOk === null ? 'not_configured' : redisOk ? 'ok' : 'error',
      env: process.env.NODE_ENV ?? 'development',
      timestamp: new Date().toISOString(),
    };
  });

  // ── API v1 ────────────────────────────────────────────────
  app.register(async (v1) => {
    v1.register(authRoutes,       { prefix: '/auth' });
    v1.register(userRoutes,       { prefix: '/users' });
    v1.register(configRoutes,     { prefix: '' });
    v1.register(ticketRoutes,     { prefix: '/tickets' });
    v1.register(complaintRoutes,  { prefix: '/complaints' });
    v1.register(returnsRoutes,    { prefix: '/returns' });
    v1.register(rmaRoutes,        { prefix: '/rma' });
    v1.register(clientRoutes,     { prefix: '/clients' });
    v1.register(csatRoutes,       { prefix: '/csat' });
    v1.register(npsRoutes,        { prefix: '/nps' });
    v1.register(recoveryRoutes,   { prefix: '/recovery-plans' });
    v1.register(dashboardRoutes,  { prefix: '/dashboard' });
  }, { prefix: '/api/v1' });


  // ── MVP static UI ──────────────────────────────────────────
  app.get('/', async (_req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'index.html');
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'UI_NOT_FOUND', message: 'public/index.html não encontrado.', status: 404 });
    }
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(filePath, 'utf8'));
  });

  app.get('/index.html', async (_req, reply) => {
    const filePath = path.join(process.cwd(), 'public', 'index.html');
    if (!fs.existsSync(filePath)) {
      return reply.code(404).send({ error: 'UI_NOT_FOUND', message: 'public/index.html não encontrado.', status: 404 });
    }
    return reply.type('text/html; charset=utf-8').send(fs.readFileSync(filePath, 'utf8'));
  });

  // ── 404 / Error handlers ──────────────────────────────────
  app.setNotFoundHandler((_req, reply) => {
    reply.code(404).send({ error: 'NOT_FOUND', message: 'Rota não encontrada.', status: 404 });
  });

  app.setErrorHandler((err: any, req, reply) => {
    req.log.error(err);
    if (err.validation) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: err.message, status: 400 });
    }
    reply.code(500).send({ error: 'INTERNAL_ERROR', message: 'Erro interno do servidor.', status: 500 });
  });

  return app;
}

// ── Start only when run directly ─────────────────────────────
if (require.main === module) {
  buildApp().then(async (app) => {
    const port = parseInt(process.env.PORT ?? '3001');
    const host = process.env.HOST ?? '0.0.0.0';
    await app.listen({ port, host });
    console.log(`\n🚀 Nextra CSO Hub API → http://localhost:${port}`);
    console.log(`   Health check  → http://localhost:${port}/health\n`);
  }).catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
