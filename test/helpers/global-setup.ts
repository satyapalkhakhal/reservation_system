import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type { TestProject } from 'vitest/node';
import pg from 'pg';
import { runMigrations } from '../../src/db/migrate.js';

let container: StartedPostgreSqlContainer | undefined;

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** One real PostgreSQL 18 for the whole run, migrated once. */
export async function setup(project: TestProject): Promise<void> {
  let databaseUrl = process.env.TEST_DATABASE_URL;
  if (!databaseUrl) {
    container = await new PostgreSqlContainer('postgres:18-alpine')
      .withCommand(['postgres', '-c', 'max_connections=300'])
      .start();
    databaseUrl = container.getConnectionUri();
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    await runMigrations(pool);
  } finally {
    await pool.end();
  }
  project.provide('databaseUrl', databaseUrl);
}

export async function teardown(): Promise<void> {
  await container?.stop();
}
