import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from './pool.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));
// Arbitrary constant; serializes concurrent migrators (e.g. several replicas booting).
const MIGRATION_LOCK_ID = 727_001;

export interface MigrationLogger {
  info(obj: object, msg?: string): void;
}

/**
 * Minimal forward-only migration runner:
 * applies src/db/migrations/*.sql in lexical order, each in its own
 * transaction, recording applied versions in schema_migrations.
 */
export async function runMigrations(pool: Pool, log?: MigrationLogger): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);

    const done = new Set(
      (await client.query<{ version: string }>('SELECT version FROM schema_migrations')).rows.map(
        (r) => r.version,
      ),
    );
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort();

    for (const file of files) {
      const version = path.basename(file, '.sql');
      if (done.has(version)) continue;
      const sql = await readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (version) VALUES ($1)', [version]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      applied.push(version);
      log?.info({ event: 'migration_applied', version }, `applied migration ${version}`);
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]).catch(() => undefined);
    client.release();
  }
  return applied;
}
