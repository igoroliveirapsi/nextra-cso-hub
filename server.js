#!/usr/bin/env node
require('dotenv').config();
const Fastify = require('fastify');
const fs = require('fs');
const path = require('path');

console.log('[SERVER] Iniciando Nextra CSO Hub v1.1...');

const app = Fastify({
  logger: true
});

// Ler HTML uma vez
const htmlPath = path.join(__dirname, 'index.html');
let htmlContent = '';

if (fs.existsSync(htmlPath)) {
  htmlContent = fs.readFileSync(htmlPath, 'utf8');
  console.log(`[HTML] Arquivo carregado: ${htmlPath} (${htmlContent.length} bytes)`);
} else {
  console.warn(`[WARN] Arquivo index.html não encontrado em ${htmlPath}`);
}

// Health check (CRÍTICO para Railway)
app.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

// Servir HTML na raiz
app.get('/', async (request, reply) => {
  if (!htmlContent) {
    return reply.status(404).send({ error: 'index.html not found' });
  }
  return reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(htmlContent);
});

// Servir index.html direto
app.get('/index.html', async (request, reply) => {
  if (!htmlContent) {
    return reply.status(404).send({ error: 'index.html not found' });
  }
  return reply
    .header('Content-Type', 'text/html; charset=utf-8')
    .send(htmlContent);
});

// API dummy para login (para testes)
app.post('/api/v1/auth/login', async (request, reply) => {
  return { 
    token: 'test-token-12345', 
    user: { 
      id: 1, 
      name: 'Igor Oliveira', 
      email: 'igor@nextra.com', 
      login: 'igor', 
      role: 'admin' 
    } 
  };
});

// Catch-all para rotas da API (retorna 404 amigável)
app.all('/api/*', async (request, reply) => {
  return reply.status(404).send({ error: 'API endpoint not implemented yet' });
});

// Error handler
app.setErrorHandler((error, request, reply) => {
  console.error('[ERROR]', error.message);
  return reply.status(500).send({ error: error.message });
});

// Start server
const start = async () => {
  try {
    const PORT = process.env.PORT || 3000;
    const HOST = '0.0.0.0';
    
    await app.listen({ port: PORT, host: HOST });
    
    console.log(`\n═══════════════════════════════════════`);
    console.log(`✓ Server listening on http://${HOST}:${PORT}`);
    console.log(`✓ Health: http://${HOST}:${PORT}/health`);
    console.log(`✓ App: http://${HOST}:${PORT}/`);
    console.log(`═══════════════════════════════════════\n`);
  } catch (err) {
    console.error('\n✗ STARTUP ERROR:', err.message);
    process.exit(1);
  }
};

start();

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received');
  app.close(() => {
    console.log('[SHUTDOWN] Server closed');
    process.exit(0);
  });
});
