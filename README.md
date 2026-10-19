# Seat Reservation API

A backend-only JSON REST API for reserving event seats, built to stay correct under extreme concurrency:

- a seat is **never** confirmed for two users (500 users racing for one seat → exactly one `201`, the rest `409`);
- a user **never** exceeds the per-show seat limit, even when firing many requests at once;
- retried requests with the same idempotency key **never** create duplicates;
- expected conflicts are `409`, never `500`; database outages are `503`, never a guess.

**Stack:** Node.js 24 LTS · TypeScript · Fastify 5 · PostgreSQL 18 (`pg`) · Zod · Pino · prom-client · Vitest + Testcontainers · Docker. No Redis, queues or ORMs: PostgreSQL is the system of record and makes every reservation decision.

The design rationale (atomic decision point, lock ordering, idempotency, failure modes, observability) is in [WRITEUP.md](WRITEUP.md).

---

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Configuration](#configuration)
- [Database and migrations](#database-and-migrations)
- [Authentication](#authentication)
- [API](#api)
- [Reservation semantics](#reservation-semantics)
- [Concurrency design (summary)](#concurrency-design-summary)
- [Testing](#testing)
- [Burst testing](#burst-testing)
- [Observability](#observability)
- [Deployment](#deployment)

---

## Quick start

Requirements: Docker with Compose v2. (For running outside Docker: Node ≥ 24 and pnpm, via `corepack enable`.)

```bash
docker compose up --build        # PostgreSQL 18 + API on http://localhost:3000
./burst.sh http://localhost:3000 # concurrency burst test + reconciliation (needs only Node ≥ 22.18)
```

The app container waits for PostgreSQL to be healthy, applies migrations, then starts. The defaults in `docker-compose.yml` are **local-only placeholders**; override them via `.env` (see `.env.example`).

Try it:

```bash
TOKEN=$(curl -s -X POST localhost:3000/auth/dev-token \
  -H 'content-type: application/json' -d '{"user_id":"user-123"}' | jq -r .access_token)

SHOW=$(curl -s -X POST localhost:3000/shows -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"friday-night","seats":["A1","A2","A3","A4"],"price_paise":25000}' | jq -r .id)

curl -s -X POST localhost:3000/shows/$SHOW/reserve -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -d '{"seats":["A1","A2"],"idempotency_key":"order-42"}'

curl -s localhost:3000/shows/$SHOW
```

### Running without Docker

```bash
corepack enable
pnpm install
cp .env.example .env               # edit DATABASE_URL / JWT_SECRET
docker compose up -d postgres      # or point DATABASE_URL at any PostgreSQL ≥ 13
set -a; source .env; set +a
pnpm migrate:dev                   # apply migrations
pnpm dev                           # watch mode (tsx)
# production build:
pnpm build && pnpm migrate && pnpm start
```

Scripts: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm burst <url>`.

---

## Architecture

A modular monolith. Routes are thin (validate → call service → shape response); services own business rules and transactions; repositories hold SQL. The reservation transaction is a single readable function: [`ReservationService.reserve`](src/modules/reservations/service.ts).

```
src/
  app.ts                      buildApp(): wires modules, error handler, logging, metrics
  server.ts                   process entry: pools, listen, graceful shutdown
  config/env.ts               Zod-validated environment
  db/
    pool.ts                   pg pools (request pool + tiny readiness pool), TLS modes
    transaction.ts            withTransaction(): BEGIN/COMMIT/ROLLBACK on ONE client, bounded deadlock retry
    migrate.ts, migrate-cli.ts  forward-only SQL migrations under an advisory lock
    migrations/001_init.sql   schema + every correctness constraint, commented
    pg-errors.ts              SQLSTATE codes we handle
  modules/
    auth/                     AuthVerifier interface, HS256 JWT impl, requireAuth preHandler, dev token route
    shows/                    POST /shows, GET /shows/:id
    reservations/             reserve + cancel: routes, service (transactions), repository (SQL), request hash
    health/                   /health/live, /health/ready
  observability/
    logger.ts                 pino config, request ids, redaction, one http_request line per request
    metrics.ts                prom-client registry, counters, DB-backed seat gauges
    http-metrics.ts           /metrics route + HTTP latency hook
  common/
    errors/                   typed DomainError classes + central HTTP mapping
    utils/                    validation, seat ordering
test/                         Vitest integration tests against real PostgreSQL (Testcontainers)
scripts/burst.ts, burst.sh    burst test against any live URL
```

---

## Configuration

All configuration is via environment variables, validated at startup (the process refuses to start on invalid config). See [.env.example](.env.example).

| Variable | Default | Purpose |
|---|---|---|
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Listen address |
| `NODE_ENV` | `development` | `development` \| `test` \| `production` |
| `LOG_LEVEL` | `info` | pino level |
| `DATABASE_URL` | **required** | PostgreSQL connection string |
| `DATABASE_SSL_MODE` | `disable` | `disable` \| `verify` (TLS + cert verification) \| `no-verify` (explicit opt-in only) |
| `DATABASE_CA_CERT` | – | PEM CA bundle for `verify` with a private CA |
| `LISTEN_BACKLOG` | `4096` | HTTP accept-queue size (Node default 511 overflows under connection bursts behind a proxy) |
| `WEB_CONCURRENCY` | `1` (`auto` in compose) | Node processes: `auto` = one cluster worker per CPU core sharing the port; `1` = single process. Correctness does not depend on it (all decisions are in PostgreSQL); `/metrics` is merged across workers |
| `DB_POOL_MAX` | auto | Connections per process. Unset: 20 for one process, or `DB_POOL_TOTAL ÷ workers` in cluster mode |
| `DB_POOL_TOTAL` | `160` | Connection budget split across cluster workers (keep below PostgreSQL `max_connections`, 300 in compose) |
| `METRICS_AGG_PORT` | `9464` | Internal (127.0.0.1) port where the cluster primary merges worker metrics |
| `DB_POOL_ACQUIRE_TIMEOUT_MS` | `30000` | Max wait for a pool connection before answering `503` |
| `DB_LOCK_TIMEOUT_MS` | `10000` | PostgreSQL `lock_timeout` (→ `503`, never a hang) |
| `DB_STATEMENT_TIMEOUT_MS` | `15000` | PostgreSQL `statement_timeout` |
| `PER_USER_LIMIT` | `4` | Default per-user seat limit for new shows |
| `JWT_SECRET` | **required** (≥ 32 chars) | HS256 signing/verification key |
| `JWT_ISSUER` | `seat-reservation` | Required `iss` claim |
| `JWT_TTL_SECONDS` | `3600` | Lifetime of dev-issued tokens |
| `AUTH_DEV_TOKENS_ENABLED` | `false` | Expose `POST /auth/dev-token` |
| `RUN_MIGRATIONS` | `true` | (Docker entrypoint) run migrations before starting |

---

## Database and migrations

Tables: `shows`, `show_seats`, `reservations`, `reservation_seats`, `user_show_quotas`, `idempotency_keys` (plus `schema_migrations`). The full schema with a comment on every constraint is in [src/db/migrations/001_init.sql](src/db/migrations/001_init.sql). The constraints that matter most:

| Constraint | Why it exists |
|---|---|
| `UNIQUE (show_id, seat_number)` on `show_seats` | A show cannot contain the same seat twice. |
| `CHECK ((status = 'available') = (reservation_id IS NULL))` | An available seat has no owner; a taken seat always has one. |
| **Partial unique index** `reservation_seats (seat_id) WHERE active` | A seat can belong to at most one active reservation. Even a bug in the locking code cannot produce a double sale; PostgreSQL rejects it (mapped to `409 SEAT_TAKEN`). |
| `PRIMARY KEY (reservation_id, seat_id)` | A reservation lists each seat once. |
| `UNIQUE (user_id, show_id, idempotency_key)` | A key identifies at most one reservation per user per show. |
| `PRIMARY KEY (user_id, show_id)` + `CHECK (seats_reserved >= 0)` on `user_show_quotas` | One serialization row per user per show; counter cannot go negative. |
| `CHECK (price_paise >= 0)`, `bigint` money columns | Money is integer paise only. |
| `seat_number COLLATE "C"` | Lock order (`ORDER BY seat_number`) is identical on every machine/locale. |

Migrations are plain SQL files applied in order, each in its own transaction, under a PostgreSQL advisory lock, so several replicas can start simultaneously:

```bash
pnpm migrate          # compiled (dist/), used in production
pnpm migrate:dev      # from source via tsx
```

The Docker entrypoint runs them automatically (with retries while the database comes up). Set `RUN_MIGRATIONS=false` to run them as a separate release step instead.

---

## Authentication

Every write endpoint requires `Authorization: Bearer <token>`. Tokens are HS256 JWTs; the user id is the verified `sub` claim. **Identity is never read from a request body**: a `user_id` field in a body is ignored (and tested to be ignored).

- The app depends only on an `AuthVerifier` interface ([src/modules/auth/types.ts](src/modules/auth/types.ts)). Moving to a real identity provider (JWKS/OIDC, RS256) means swapping one implementation.
- For the assignment, `POST /auth/dev-token {"user_id":"user-123"}` issues a token for any user id. It exists **only** when `AUTH_DEV_TOKENS_ENABLED=true`, and is meant for evaluation and burst testing, not production.
- Tokens are verified for signature, `alg=HS256` only (no `alg=none`), issuer, expiry, and a well-formed subject. Tokens are redacted from logs.

`POST /shows` requires any authenticated user (roles/admin are out of scope). `GET /shows/:id`, health and metrics are public.

---

## API

All bodies are JSON. Errors have one shape:

```json
{ "error": { "code": "SEAT_TAKEN", "message": "One or more requested seats are not available", "details": { "seats": ["A13"] } } }
```

Every response carries `x-request-id` (an incoming well-formed `X-Request-Id` is propagated).

### `POST /shows` (auth)

```json
{ "name": "friday-night", "seats": ["A1", "A2", "A3", "A4"], "price_paise": 25000, "per_user_limit": 4 }
```

`per_user_limit` is optional (default `PER_USER_LIMIT`). `price_paise` must be a non-negative **integer**; `250.5` or `"25000"` is a `400`. Seat labels: 1–32 chars of `[A-Za-z0-9_-]`, unique. Returns `201` with the show state (below).

### `GET /shows/:showId`

```json
{
  "id": "…", "name": "friday-night", "price_paise": 25000, "per_user_limit": 4,
  "created_at": "2026-10-18T12:00:00.000Z",
  "total_seats": 4,
  "counts": { "available": 3, "held": 0, "confirmed": 1 },
  "seats": [ { "seat": "A1", "status": "confirmed" }, { "seat": "A2", "status": "available" }, … ]
}
```

Seat list and counts come from one SQL statement (one snapshot), so `available + held + confirmed == total_seats` always. `held` is part of the model for future time-boxed holds and is currently always `0`.

### `POST /shows/:showId/reserve` (auth)

```json
{ "seats": ["A12", "A13"], "idempotency_key": "unique-client-key" }
```

`201 Created`:

```json
{
  "reservation_id": "…", "show_id": "…", "user_id": "user-123",
  "seats": ["A12", "A13"], "amount_paise": 50000, "status": "confirmed",
  "created_at": "…", "cancelled_at": null
}
```

| Status | `error.code` | When |
|---|---|---|
| `201` | – | Reserved. Also returned for an idempotent replay, with header `Idempotent-Replayed: true` and the original body. |
| `400` | `VALIDATION_ERROR` | Missing/invalid `seats` or `idempotency_key`, duplicate seats, malformed id |
| `401` | `UNAUTHENTICATED` | Missing/invalid/expired token |
| `404` | `SHOW_NOT_FOUND` | Unknown show |
| `409` | `SEAT_TAKEN` | Any requested seat is not available (`details.seats` lists them) |
| `409` | `PER_USER_LIMIT` | Would exceed the show's per-user limit (`details` has limit / already reserved / requested) |
| `409` | `IDEMPOTENCY_CONFLICT` | Key already used by this user for this show with a different request |
| `422` | `UNKNOWN_SEATS` | A requested seat does not exist in the show |
| `503` | `SERVICE_UNAVAILABLE` | Database unreachable/overloaded; safe to retry with the same key (`Retry-After: 1`) |

### `POST /reservations/:reservationId/cancel` (auth)

Owner only. `200` with the reservation (`status: "cancelled"`, `cancelled_at` set); its seats become `available`. `403 FORBIDDEN` for another user's reservation, `404 RESERVATION_NOT_FOUND`, `409 ALREADY_CANCELLED` for a second cancel.

### Operations

| Endpoint | |
|---|---|
| `GET /health/live` | `200 {"status":"ok"}` while the process serves HTTP. No dependencies. |
| `GET /health/ready` | `200 {"status":"ready","database":"ok"}` if PostgreSQL answers `SELECT 1` within 2 s, else `503 {"status":"not_ready","database":"unavailable"}`. |
| `GET /metrics` | Prometheus text format. |
| `POST /auth/dev-token` | `{"user_id": "…"}` → `{"access_token","token_type":"Bearer","expires_in"}` (only if enabled). |

---

## Reservation semantics

- **All-or-nothing.** A multi-seat request either confirms every seat or none. If `A12` is free and `A13` is taken, `["A12","A13"]` returns `409 SEAT_TAKEN` (`details.seats: ["A13"]`), and `A12` stays available.
- **Per-user limit** counts all of a user's confirmed seats in that show, across reservations. Cancelling frees the quota.
- **Money** is `amount_paise = price_paise × seats`, integers end to end (`bigint` in PostgreSQL).
- **Idempotency** (`idempotency_key` is required):
  - scope is `(user, show, key)`; different users can use the same key independently, and a user can never replay someone else's reservation;
  - same key + same request → the original reservation (`201`, `Idempotent-Replayed: true`); nothing new is created;
  - "same request" means same show and same **set** of seats: seat order and extra/unknown body fields don't matter (the hash is built from normalized fields, not raw JSON);
  - same key + different request → `409 IDEMPOTENCY_CONFLICT`;
  - concurrent retries with one key → exactly one reservation; all of them receive it;
  - only **successful** reservations bind a key. A declined attempt (e.g. `409 SEAT_TAKEN`) stores nothing, so retrying the same key later is evaluated afresh;
  - replaying a key whose reservation was since cancelled returns that reservation with its current `status: "cancelled"`; it does not re-reserve.
- **Cancellation** releases exactly the seats the reservation still owns, and can never touch a seat that now belongs to someone else.

---

## Concurrency design (summary)

Full reasoning in [WRITEUP.md](WRITEUP.md). In short, `reserve` runs one READ COMMITTED transaction on one connection:

1. `INSERT … ON CONFLICT DO NOTHING` + `SELECT … FOR UPDATE` the `(user, show)` row in `user_show_quotas`. This serializes one user's requests for one show.
2. Look up the idempotency key (under that lock) → replay or `409`.
3. `SELECT … WHERE status = 'available' ORDER BY seat_number FOR UPDATE` → lock the requested seats that are still free, in a global order. Fewer rows than requested → decline.
4. Check the per-user limit against the locked counter.
5. Insert reservation + `reservation_seats`, flip seats to `confirmed` (guarded by `status = 'available'`), bump the counter, store the key. `COMMIT`.

Any failure rolls back everything. Every writer takes locks in the same order (user row → reservation row (cancel) → seats by `seat_number`), so lock cycles cannot form; deadlock/serialization errors are still retried (bounded) rather than surfaced. A lock-free single-statement probe declines requests for already-taken seats before the transaction, keeping hot-seat storms out of the lock queue; it can only decline, never confirm.

---

## Testing

```bash
pnpm test        # starts PostgreSQL 18 in Docker via Testcontainers; needs Docker
pnpm typecheck
pnpm lint
```

Set `TEST_DATABASE_URL` to run against an existing (empty, disposable) database instead of a container.

Tests run the real app on a random port and send real HTTP requests through the real connection pool to a real PostgreSQL. No mocks for anything concurrency-related. Every mutating test ends with a reconciliation check ([test/helpers/reconcile.ts](test/helpers/reconcile.ts)): API counts sum to the total; every taken seat has exactly one confirmed owner mirrored in an active `reservation_seats` row; no seat has two active owners; per-user counters equal actual confirmed seats and are within the limit; `amount_paise = price × seats`.

| File | Covers |
|---|---|
| `shows.test.ts` | create/get, money validation, seat validation, auth |
| `reservations.test.ts` | single/multi reserve, all-or-nothing, per-user limit, unknown seats, cancel/re-book, double cancel |
| `auth.test.ts` | token identity, spoofed body `user_id`, forged/expired/wrong-issuer/`alg=none` tokens, foreign cancel = 403, dev-token toggle |
| `idempotency.test.ts` | replay, reordered seats, different body, 100 concurrent retries, same-key different bodies racing, per-user scope, declines don't consume keys, replay after cancel, winner retries during a storm |
| `concurrency.test.ts` | 500-way hot seat, 300 overlapping multi-seat requests, opposite lock orders, one user × 20 concurrent, mixed sizes, 30 users × 10 concurrent, reserve/cancel churn |
| `health.test.ts` | live/ready, DB unreachable → ready `503` and reserve `503` |
| `metrics.test.ts` | counters and seat gauges reconcile with API/DB state; no identifier labels |
| `logging.test.ts` | JSON lines with `request_id`, token redaction, declines at `info` |
| `hash.test.ts` | request-hash normalization (unit) |

The concurrency tests were checked for sensitivity by deliberately removing the seat `FOR UPDATE`, the conditional update and the partial unique index: they fail (e.g. 20 "winners" for the same seats). Removing only the user-row lock fails the per-user-limit tests.

---

## Burst testing

```bash
./burst.sh <BASE_URL>                                    # e.g. ./burst.sh https://seats.example.com
./burst.sh http://localhost:3000 --hot 5000 --concurrency 1000 --same-user 20 --retries 50 --overlap 500
./burst.sh https://reservation.example.com --stampede 25000 --concurrency 5000   # + on-sale stampede
```

Zero dependencies: only Node ≥ 22.18 (runs `scripts/burst.ts` with built-in type stripping). It uses only the public API. Tokens come from `POST /auth/dev-token` (server needs `AUTH_DEV_TOKENS_ENABLED=true`), or set `BURST_JWT_SECRET` (and `BURST_JWT_ISSUER`) to sign tokens locally instead.

Scenarios: (1) hot-seat storm, N distinct users → one seat; (2) one user firing many concurrent requests; (3) concurrent retries with one idempotency key, then same key with a different body; (4) overlapping multi-seat requests in mixed seat order; (5) optional **on-sale stampede** (`--stampede N`): one fresh show, ~50% of requests on a few hot seats (`--hot-seats`, default 5), ~30% across the hall (`--hall`, default 500), ~20% exact retries; the show is polled *during* the storm to check the invariant live, and `reservations_confirmed_total` must move by exactly the reservations created; (6) reconciliation of every show via `GET /shows/:id`.

Load is generated from several worker threads (`--workers`, default CPU cores − 1): a single JS thread saturates at a few thousand concurrent HTTPS requests and would measure its own queue instead of the server. It prints status/reason breakdowns, latency percentiles and server metrics, and exits non-zero if any check fails.

Result against `docker compose up` on a laptop (abridged):

```
=== 1. Hot-seat storm: 5000 users -> seat A12 ===
Total requests: 5000
201: 1
409 SEAT_TAKEN: 4999
5xx: 0
=== 2. Same-user concurrency: 1 user, 20 parallel requests (limit 4) ===
201: 4
409 PER_USER_LIMIT: 16
=== 3. Idempotency: 50 concurrent retries, same key ===
201: 50   (distinct reservation ids=1)
same key + different body -> 409 IDEMPOTENCY_CONFLICT
=== Reconciliation ===
hot-seat     total=100 available=99 held=0 confirmed=1 sum=100 PASS
same-user    total=20 available=16 held=0 confirmed=4 sum=20 PASS
idempotency  total=10 available=8 held=0 confirmed=2 sum=10 PASS
overlap      total=20 available=0 held=0 confirmed=20 sum=20 PASS
ALL CHECKS PASSED
```

---

## Observability

**Metrics** (`GET /metrics`):

| Metric | Type | Notes |
|---|---|---|
| `reservations_confirmed_total` | counter | new reservations only |
| `reservations_declined_total{reason}` | counter | `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_conflict`, `unknown_seats`, `show_not_found`, `validation`, `unavailable` (all pre-initialized to 0) |
| `reservations_cancelled_total` | counter | |
| `reservation_duration_seconds{outcome}` | histogram | `confirmed` / `replayed` / `declined` / `error` |
| `http_request_duration_seconds`, `http_requests_total` `{method,route,status_code}` | histogram / counter | `route` is the template (`/shows/:showId/reserve`), never the raw URL |
| `seats_available`, `seats_held`, `seats_confirmed`, `seats_total` | gauge | read from PostgreSQL **at scrape time**: always equal to the sum of `GET /shows/:id` counts across shows, regardless of restarts or replica count |
| `seat_metrics_scrape_success` | gauge | `0` if the seat gauges could not be read (gauges are then omitted rather than stale) |
| `db_pool_connections{state}` | gauge | `total` / `idle` / `waiting` |
| Node.js process defaults | | event-loop lag, heap, GC, … |

No `user_id`, `reservation_id`, `request_id` or `show_id` labels.

**Logs** are JSON lines (pino) with ISO `time`, string `level`, `service`, and `request_id` on every request-scoped line. Domain events carry `event`, `show_id`, `user_id`, `reservation_id`, `seats`:

```json
{"level":"info","time":"…","service":"seat-reservation","request_id":"eee4b1e6-…","event":"reservation_confirmed","show_id":"…","user_id":"user-123","reservation_id":"…","seats":["A12"]}
{"level":"info","time":"…","request_id":"e5bf31b1-…","event":"reservation_declined","reason":"seat_taken","show_id":"…","user_id":"user-456","details":{"seats":["A12"]}}
```

Expected outcomes (`409`, `4xx`) log at `info`; database unavailability at `warn`; only unexpected failures at `error` (with stack in the log, never in the response). `Authorization` headers and tokens are redacted.

---

## Deployment

The image is self-contained: it runs migrations (advisory-locked, retried while the database starts) and then the server, and handles `SIGTERM` gracefully (stops accepting, drains, closes pools).

Any platform that runs a Dockerfile next to a managed PostgreSQL works. Generic steps:

1. Provision PostgreSQL ≥ 13 (18 used in development).
2. Deploy this repository's `Dockerfile` as a web service listening on `$PORT` (default 3000).
3. Set environment variables: `DATABASE_URL`, `JWT_SECRET` (`openssl rand -base64 48`), `DATABASE_SSL_MODE=verify` for databases reached over the internet, and `AUTH_DEV_TOKENS_ENABLED=true` if evaluators/burst tests need to mint tokens.
4. Health check path: `/health/ready` (readiness) and `/health/live` (liveness).
5. Run `./burst.sh https://<your-host>`.

### Single VM with HTTPS (Docker Compose + Caddy)

This is how the live instance runs: one VM (e.g. GCP e2-standard-2, Ubuntu 24.04) running PostgreSQL, the API and [Caddy](https://caddyserver.com) via `docker-compose.prod.yml`. Caddy terminates TLS with an automatic Let's Encrypt certificate and forwards to the API over the internal Docker network; PostgreSQL is bound to `127.0.0.1` only.

1. Point a DNS **A record** for your hostname (e.g. `reservation.example.com`) at the VM's static IP.
2. Open inbound TCP **80 and 443** (GCP: tick *Allow HTTP traffic* and *Allow HTTPS traffic*).
3. On the VM:
   ```bash
   curl -fsSL https://get.docker.com | sudo sh && sudo usermod -aG docker $USER && newgrp docker
   git clone <this repo> && cd <repo>
   cat > .env <<EOF
   DOMAIN=reservation.example.com
   POSTGRES_PASSWORD=$(openssl rand -hex 24)
   JWT_SECRET=$(openssl rand -base64 48)
   AUTH_DEV_TOKENS_ENABLED=true
   EOF
   chmod 600 .env
   docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
   ```
4. `curl https://reservation.example.com/health/ready`, then `./burst.sh https://reservation.example.com` from another machine.

To update: `git pull && docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build`. All containers use `restart: unless-stopped`, so the stack comes back after a VM reboot.

### Managed platforms

Examples:

- **Render:** create a PostgreSQL instance and a *Web Service* from this repo (runtime: Docker). Set `DATABASE_URL` to the **internal** connection string (`DATABASE_SSL_MODE=disable` on the private network, or the external URL with `verify`), `JWT_SECRET`, `AUTH_DEV_TOKENS_ENABLED=true`; health check path `/health/ready`.
- **Fly.io:** `fly launch` (detects the Dockerfile), `fly postgres create` + `fly postgres attach` (sets `DATABASE_URL`), `fly secrets set JWT_SECRET=… AUTH_DEV_TOKENS_ENABLED=true`, add an HTTP check on `/health/ready`, `fly deploy`.

Sizing notes: keep `DB_POOL_MAX × replicas` below the database's `max_connections` (minus headroom for the 2-connection readiness pool per replica and migrations). Correctness does not depend on the number of replicas; all coordination happens in PostgreSQL.
