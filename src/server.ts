import { loadEnv } from './config/env.js';
import { createPool } from './db/pool.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const app = await buildApp({ env, pool });

  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', (err) => app.log.warn({ event: 'pg_idle_client_error', err }, 'idle pg client error'));

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: 'shutdown', signal }, 'shutting down');
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST });
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
