import cluster from 'node:cluster';
import type { FastifyInstance } from 'fastify';
import type { Metrics } from './metrics.js';

/** Registers the /metrics route and per-request HTTP metrics. */
export async function metricsPlugin(
  app: FastifyInstance,
  opts: { metrics: Metrics; aggregatorPort: number },
): Promise<void> {
  const { metrics, aggregatorPort } = opts;

  app.addHook('onResponse', async (request, reply) => {
    // Route template ("/shows/:showId"), never the raw URL: keeps cardinality bounded.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    metrics.httpTotal.inc(labels);
    metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_request, reply) => {
    if (cluster.isWorker) {
      // One process's counters would not reconcile with the API: serve the
      // view merged across all workers by the cluster primary.
      const res = await fetch(`http://127.0.0.1:${aggregatorPort}/metrics`, { signal: AbortSignal.timeout(10_000) });
      reply.status(res.status).header('content-type', res.headers.get('content-type') ?? 'text/plain');
      return res.text();
    }
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
