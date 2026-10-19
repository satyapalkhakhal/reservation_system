import cluster from 'node:cluster';
import { AggregatorRegistry, Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import type { Pool } from '../db/pool.js';

export const DECLINE_REASONS = [
  'seat_taken',
  'per_user_limit',
  'idempotent_replay',
  'idempotency_conflict',
  'unknown_seats',
  'show_not_found',
  'validation',
  'unavailable',
] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

// Kept only for its side effect (IPC listener); never read.
let workerAggregator: object | undefined;

/**
 * All metrics live in a per-app Registry (not the prom-client global) so
 * multiple app instances can coexist in tests.
 *
 * Label rule: only small, bounded sets (reason, outcome, method, route
 * template, status code). Never user_id / reservation_id / request_id / show_id.
 */
export function createMetrics(pool: Pool) {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  // In cluster mode the primary asks every worker for this registry and
  // merges them: counters/histograms are summed, gauges use the aggregator
  // declared on each metric.
  if (cluster.isWorker) {
    // prom-client only installs the worker's "send my metrics" IPC listener
    // when an AggregatorRegistry is constructed, so construct one once.
    workerAggregator ??= new AggregatorRegistry();
    AggregatorRegistry.setRegistries([registry]);
  }

  const reservationsConfirmed = new Counter({
    name: 'reservations_confirmed_total',
    help: 'Reservations successfully confirmed (new reservations only, not replays)',
    registers: [registry],
  });

  const reservationsDeclined = new Counter({
    name: 'reservations_declined_total',
    help: 'Reservation requests that did not create a new reservation, by reason',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  for (const reason of DECLINE_REASONS) reservationsDeclined.labels(reason).inc(0);

  const reservationsCancelled = new Counter({
    name: 'reservations_cancelled_total',
    help: 'Reservations cancelled (seats released)',
    registers: [registry],
  });

  const reservationDuration = new Histogram({
    name: 'reservation_duration_seconds',
    help: 'Wall time of the reservation transaction, by outcome',
    labelNames: ['outcome'] as const, // confirmed | replayed | declined | error
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const httpDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  const httpTotal = new Counter({
    name: 'http_requests_total',
    help: 'HTTP requests',
    labelNames: ['method', 'route', 'status_code'] as const,
    registers: [registry],
  });

  // Seat gauges come from PostgreSQL. In cluster mode the primary registers
  // them once (one query per scrape instead of one per worker).
  if (!cluster.isWorker) registerSeatGauges(registry, pool);

  new Gauge({
    name: 'db_pool_connections',
    help: 'Request pool connections by state (summed across cluster workers)',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.labels('total').set(pool.totalCount);
      this.labels('idle').set(pool.idleCount);
      this.labels('waiting').set(pool.waitingCount); // requests queued for a connection
    },
  });

  return {
    registry,
    reservationsConfirmed,
    reservationsDeclined,
    reservationsCancelled,
    reservationDuration,
    httpDuration,
    httpTotal,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

/**
 * Seat gauges read from PostgreSQL at scrape time, so they always match what
 * GET /shows/:id reports (summed across shows), across restarts and replicas.
 * All four share one query per scrape.
 */
export function registerSeatGauges(registry: Registry, pool: Pool): void {
  type SeatCounts = { available: number; held: number; confirmed: number };
  let seatRead: Promise<SeatCounts | null> | null = null;
  function readSeatCounts(): Promise<SeatCounts | null> {
    if (!seatRead) {
      seatRead = pool
        .query<{ status: keyof SeatCounts; n: number }>(`SELECT status, count(*)::int AS n FROM show_seats GROUP BY status`)
        .then(({ rows }) => {
          const counts: SeatCounts = { available: 0, held: 0, confirmed: 0 };
          for (const r of rows) counts[r.status] = r.n;
          return counts;
        })
        .catch(() => null)
        // Shared only by the gauges of this scrape; the next scrape re-reads.
        .finally(() => setImmediate(() => (seatRead = null)));
    }
    return seatRead;
  }
  function seatGauge(name: string, help: string, pick: (c: SeatCounts) => number): Gauge {
    return new Gauge({
      name,
      help,
      registers: [registry],
      async collect() {
        const c = await readSeatCounts();
        // Do not export stale numbers as if they were current.
        if (c) this.set(pick(c));
        else this.reset();
      },
    });
  }
  seatGauge('seats_available', 'Seats currently available (all shows)', (c) => c.available);
  seatGauge('seats_held', 'Seats currently held (all shows)', (c) => c.held);
  seatGauge('seats_confirmed', 'Seats currently confirmed (all shows)', (c) => c.confirmed);
  seatGauge('seats_total', 'All seats (all shows)', (c) => c.available + c.held + c.confirmed);
  new Gauge({
    name: 'seat_metrics_scrape_success',
    help: '1 if seat gauges were read from PostgreSQL on this scrape, else 0',
    registers: [registry],
    async collect() {
      this.set((await readSeatCounts()) ? 1 : 0);
    },
  });
}


/** Map a domain error code to a bounded decline reason. */
export function declineReasonFor(errorCode: string): DeclineReason | undefined {
  switch (errorCode) {
    case 'SEAT_TAKEN':
      return 'seat_taken';
    case 'PER_USER_LIMIT':
      return 'per_user_limit';
    case 'IDEMPOTENCY_CONFLICT':
      return 'idempotency_conflict';
    case 'UNKNOWN_SEATS':
      return 'unknown_seats';
    case 'SHOW_NOT_FOUND':
      return 'show_not_found';
    case 'VALIDATION_ERROR':
      return 'validation';
    case 'SERVICE_UNAVAILABLE':
      return 'unavailable';
    default:
      return undefined;
  }
}
