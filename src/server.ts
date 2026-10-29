import { createApp } from './app.js';
import { pool } from './db.js';
import { migrate } from './migrate.js';
async function start() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const proxyHops = Number(process.env.TRUST_PROXY_HOPS ?? '0');
  const port = Number(process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('PORT must be an integer between 0 and 65535');
  const app = createApp(process.env.ADMIN_API_KEY ?? '', { trustProxyHops: proxyHops });
  await migrate();
  const server = app.listen(port, '0.0.0.0', () => {
    const address = server.address();
    console.log(
      JSON.stringify({
        event: 'listening',
        port: typeof address === 'object' ? address?.port : port,
      }),
    );
  });
  server.on('error', (error) => {
    console.error('Server failed', error.message);
    void pool.end();
    process.exitCode = 1;
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let shuttingDown = false;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => {
      void pool.end().then(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
start().catch((error) => {
  console.error(error);
  void pool.end();
  process.exitCode = 1;
});
