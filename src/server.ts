import { loadEnv } from './config/env.js';
import { createHealthPool, createPool } from './db/pool.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const env = loadEnv();
  const pool = createPool(env);
  const healthPool = createHealthPool(env);
  const app = await buildApp({ env, pool, healthPool });

  // An idle client erroring (e.g. DB restart) must not crash the process.
  for (const p of [pool, healthPool]) {
    p.on('error', (err) => app.log.warn({ event: 'pg_idle_client_error', err }, 'idle pg client error'));
  }

  const shutdown = async (signal: string): Promise<void> => {
    app.log.info({ event: 'shutdown', signal }, 'shutting down');
    try {
      await app.close();
      await Promise.all([pool.end(), healthPool.end()]);
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
