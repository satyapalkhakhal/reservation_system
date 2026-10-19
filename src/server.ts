import cluster from 'node:cluster';
import http from 'node:http';
import { availableParallelism } from 'node:os';
import { AggregatorRegistry, Registry } from 'prom-client';
import { registerSeatGauges } from './observability/metrics.js';
import { loadEnv, resolvePoolMax, resolveWorkers, type Env } from './config/env.js';
import { createHealthPool, createPool } from './db/pool.js';
import { buildApp } from './app.js';

/**
 * Process entry.
 *
 * WEB_CONCURRENCY=1 (default): the API runs in this process.
 * WEB_CONCURRENCY=N|auto: this process becomes a cluster primary that forks
 * N workers sharing the listening socket (Node runs JS on one core per
 * process). The primary serves no API traffic; it supervises workers and
 * serves metrics merged across them on 127.0.0.1:METRICS_AGG_PORT, plus the
 * seat gauges, which it reads from PostgreSQL once per scrape.
 * Workers accept connections themselves (SCHED_NONE) rather than having the
 * primary accept every connection and pass it over IPC, which made the single
 * primary thread the bottleneck under bursts of new connections.
 * Correctness does not depend on the number of processes: every decision is
 * made inside PostgreSQL.
 */
async function main(): Promise<void> {
  const env = loadEnv();
  const workers = resolveWorkers(env, availableParallelism());
  if (workers > 1 && cluster.isPrimary) return runPrimary(env, workers);
  return runServer(env, workers);
}

async function runServer(env: Env, workers: number): Promise<void> {
  const pool = createPool(env, resolvePoolMax(env, workers));
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
      // Logs are written asynchronously; flush before exiting.
      await new Promise<void>((resolve) => (app.log as unknown as { flush(cb: () => void): void }).flush(() => resolve()));
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  process.once('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port: env.PORT, host: env.HOST, backlog: env.LISTEN_BACKLOG });
}

function runPrimary(env: Env, workers: number): void {
  const log = (event: string, fields: Record<string, unknown> = {}): void =>
    console.log(JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'seat-reservation', role: 'primary', event, ...fields }));

  // Metrics merged across all workers (counters summed, gauges per their
  // aggregator), followed by the seat gauges read once here.
  const aggregator = new AggregatorRegistry();
  const seatPool = createPool(env, 2);
  seatPool.on('error', () => undefined);
  const seatRegistry = new Registry();
  registerSeatGauges(seatRegistry, seatPool);
  http
    .createServer((req, res) => {
      Promise.all([aggregator.clusterMetrics(), seatRegistry.metrics()])
        .then(([workers, seats]) => {
          res.writeHead(200, { 'content-type': aggregator.contentType });
          // Seats (current state) first, then what the workers recorded.
          res.end(`${seats}\n${workers}`);
        })
        .catch((err: unknown) => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end(`metrics aggregation failed: ${(err as Error).message}`);
        });
    })
    .listen(env.METRICS_AGG_PORT, '127.0.0.1');

  let stopping = false;
  // Overridable with Node's own NODE_CLUSTER_SCHED_POLICY=rr|none.
  if (!process.env.NODE_CLUSTER_SCHED_POLICY) cluster.schedulingPolicy = cluster.SCHED_NONE;
  for (let i = 0; i < workers; i++) cluster.fork();
  log('cluster_started', { workers, pool_per_worker: resolvePoolMax(env, workers) });

  cluster.on('exit', (worker, code, signal) => {
    if (stopping) {
      if (Object.keys(cluster.workers ?? {}).length === 0) void seatPool.end().finally(() => process.exit(0));
      return;
    }
    // A crashed worker is replaced; in-flight transactions on it were rolled
    // back by PostgreSQL when its connections closed.
    log('worker_exited', { worker: worker.id, code, signal });
    cluster.fork();
  });

  const stop = (signal: string): void => {
    if (stopping) return;
    stopping = true;
    log('shutdown', { signal });
    for (const w of Object.values(cluster.workers ?? {})) w?.process.kill('SIGTERM');
    setTimeout(() => process.exit(1), 20_000).unref();
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT', () => stop('SIGINT'));
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
