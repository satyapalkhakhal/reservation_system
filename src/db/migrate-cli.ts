import { loadDbEnv } from '../config/env.js';
import { createPool } from './pool.js';
import { runMigrations } from './migrate.js';

const env = loadDbEnv();
const pool = createPool(env);

try {
  const applied = await runMigrations(pool, {
    info: (obj, msg) => console.log(JSON.stringify({ level: 'info', ...obj, msg })),
  });
  console.log(JSON.stringify({ level: 'info', event: 'migrations_complete', applied: applied.length }));
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
