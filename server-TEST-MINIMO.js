const Fastify = require('fastify');
const app = Fastify({ logger: true });

app.get('/health', async () => ({ status: 'ok' }));

app.get('/', async () => {
  return { message: 'Nextra CSO Hub v1.1 — Backend Online!', timestamp: new Date().toISOString() };
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) throw err;
  console.log(`✓ Server running at ${address}`);
});
