import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
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

  // Seat gauges are read from PostgreSQL at scrape time, so they always match
  // what GET /shows/:id reports (summed across shows), across all instances.
  const seatGauges = {
    available: new Gauge({ name: 'seats_available', help: 'Seats currently available (all shows)', registers: [registry] }),
    held: new Gauge({ name: 'seats_held', help: 'Seats currently held (all shows)', registers: [registry] }),
    confirmed: new Gauge({ name: 'seats_confirmed', help: 'Seats currently confirmed (all shows)', registers: [registry] }),
    total: new Gauge({ name: 'seats_total', help: 'All seats (all shows)', registers: [registry] }),
  };
  const seatScrapeOk = new Gauge({
    name: 'seat_metrics_scrape_success',
    help: '1 if seat gauges were read from PostgreSQL on this scrape, else 0',
    registers: [registry],
  });

  new Gauge({
    name: 'db_pool_connections',
    help: 'Request pool connections by state',
    labelNames: ['state'] as const,
    registers: [registry],
    collect() {
      this.labels('total').set(pool.totalCount);
      this.labels('idle').set(pool.idleCount);
      this.labels('waiting').set(pool.waitingCount); // requests queued for a connection
    },
  });

  async function refreshSeatGauges(): Promise<void> {
    try {
      const { rows } = await pool.query<{ status: 'available' | 'held' | 'confirmed'; n: number }>(
        `SELECT status, count(*)::int AS n FROM show_seats GROUP BY status`,
      );
      const counts = { available: 0, held: 0, confirmed: 0 };
      for (const r of rows) counts[r.status] = r.n;
      seatGauges.available.set(counts.available);
      seatGauges.held.set(counts.held);
      seatGauges.confirmed.set(counts.confirmed);
      seatGauges.total.set(counts.available + counts.held + counts.confirmed);
      seatScrapeOk.set(1);
    } catch {
      // Do not export stale numbers as if they were current.
      for (const g of Object.values(seatGauges)) g.reset();
      seatScrapeOk.set(0);
    }
  }

  return {
    registry,
    reservationsConfirmed,
    reservationsDeclined,
    reservationsCancelled,
    reservationDuration,
    httpDuration,
    httpTotal,
    refreshSeatGauges,
  };
}

export type Metrics = ReturnType<typeof createMetrics>;

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
