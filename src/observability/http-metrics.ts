import type { FastifyInstance } from 'fastify';
import type { Metrics } from './metrics.js';

/** Registers the /metrics route and per-request HTTP metrics. */
export async function metricsPlugin(app: FastifyInstance, opts: { metrics: Metrics }): Promise<void> {
  const { metrics } = opts;

  app.addHook('onResponse', async (request, reply) => {
    // Route template ("/shows/:showId"), never the raw URL: keeps cardinality bounded.
    const route = request.routeOptions.url ?? 'unmatched';
    if (route === '/metrics') return;
    const labels = { method: request.method, route, status_code: String(reply.statusCode) };
    metrics.httpTotal.inc(labels);
    metrics.httpDuration.observe(labels, reply.elapsedTime / 1000);
  });

  app.get('/metrics', async (_request, reply) => {
    await metrics.refreshSeatGauges();
    reply.header('content-type', metrics.registry.contentType);
    return metrics.registry.metrics();
  });
}
