import cluster from 'node:cluster';
import { AggregatorRegistry, Counter, Gauge, Histogram, Registry } from 'prom-client';
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

/** Shown as 0 from the start; rarer reasons appear once they first happen. */
const MAIN_DECLINE_REASONS: readonly DeclineReason[] = [
  'seat_taken',
  'per_user_limit',
  'idempotent_replay',
  'idempotency_conflict',
];

// Kept only for its side effect (IPC listener); never read.
let workerAggregator: object | undefined;

/**
 * /metrics is meant to be read by people as well as Prometheus, so it holds
 * only what explains the system at a glance, in this order:
 *   seats (current state) -> reservations (what happened) ->
 *   HTTP responses by class (is anything failing?) -> booking latency.
 * No generic runtime metrics, no per-route breakdowns.
 *
 * All metrics live in a per-app Registry (not the prom-client global) so
 * multiple app instances can coexist in tests. Labels are small fixed sets;
 * never user_id / reservation_id / request_id / show_id.
 */
export function createMetrics(pool: Pool) {
  const registry = new Registry();
  // In cluster mode the primary asks every worker for this registry and
  // merges them (counters and histograms are summed).
  if (cluster.isWorker) {
    // prom-client only installs the worker's "send my metrics" IPC listener
    // when an AggregatorRegistry is constructed, so construct one once.
    workerAggregator ??= new AggregatorRegistry();
    AggregatorRegistry.setRegistries([registry]);
  }

  // Seat gauges come from PostgreSQL. In cluster mode the cluster primary
  // serves them (one query per scrape instead of one per worker).
  if (!cluster.isWorker) registerSeatGauges(registry, pool);

  const reservationsConfirmed = new Counter({
    name: 'reservations_confirmed_total',
    help: 'Reservations booked (each seat sold once; retries not counted again)',
    registers: [registry],
  });

  const reservationsDeclined = new Counter({
    name: 'reservations_declined_total',
    help: 'Reservation requests that did not book anything new, by reason (seat_taken = someone else has it)',
    labelNames: ['reason'] as const,
    registers: [registry],
  });
  for (const reason of MAIN_DECLINE_REASONS) reservationsDeclined.labels(reason).inc(0);

  const reservationsCancelled = new Counter({
    name: 'reservations_cancelled_total',
    help: 'Reservations cancelled by their owner (seats released)',
    registers: [registry],
  });

  const httpResponses = new Counter({
    name: 'http_responses_total',
    help: 'API responses by status class (5xx should stay 0; 409 declines are 4xx)',
    labelNames: ['class'] as const,
    registers: [registry],
  });
  for (const c of ['2xx', '4xx', '5xx']) httpResponses.labels(c).inc(0);

  const reservationDuration = new Histogram({
    name: 'reservation_duration_seconds',
    help: 'Time to answer a reservation request, in seconds',
    buckets: [0.05, 0.25, 1, 5],
    registers: [registry],
  });

  return {
    registry,
    reservationsConfirmed,
    reservationsDeclined,
    reservationsCancelled,
    reservationDuration,
    httpResponses,
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
        // Database unreachable: omit the gauges rather than show stale numbers.
        if (c) this.set(pick(c));
        else this.reset();
      },
    });
  }
  seatGauge('seats_total', 'All seats across all shows (= available + held + confirmed)', (c) => c.available + c.held + c.confirmed);
  seatGauge('seats_available', 'Seats free to book right now', (c) => c.available);
  seatGauge('seats_held', 'Seats temporarily held (always 0: no hold model yet)', (c) => c.held);
  seatGauge('seats_confirmed', 'Seats sold', (c) => c.confirmed);
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
