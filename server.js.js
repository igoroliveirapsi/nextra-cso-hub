const Fastify = require('fastify');

const app = Fastify({ 
  logger: true,
  requestTimeout: 30000
});

app.get('/health', async (request, reply) => {
  return { status: 'ok', timestamp: new Date().toISOString() };
});

app.get('/', async (request, reply) => {
  return { message: 'Nextra CSO Hub Online', version: '1.1' };
});

const start = async () => {
  try {
    const PORT = process.env.PORT || 3000;
    const HOST = '0.0.0.0';
    
    await app.listen({ port: PORT, host: HOST });
    console.log(`✓ Server listening on ${HOST}:${PORT}`);
  } catch (err) {
    console.error('Server error:', err.message);
    process.exit(1);
  }
};

start();

module.exports = app;
