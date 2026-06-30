const Fastify = require('fastify');
const app = Fastify({ logger: true });

app.get('/health', async () => {
  return { status: 'ok' };
});

app.get('/', async (req, reply) => {
  return { message: 'Server OK' };
});

const PORT = process.env.PORT || 3000;
app.listen({ port: PORT, host: '0.0.0.0' }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server running at ${address}`);
});
