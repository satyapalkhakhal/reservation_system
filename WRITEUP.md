# Write-up: Seat Reservation at Scale

## 1. Atomic decision

**Where:** one PostgreSQL transaction in [`ReservationService.reserve`](src/modules/reservations/service.ts), on one pooled connection, at the default **READ COMMITTED** isolation. The deciding statement is ([repository.ts](src/modules/reservations/repository.ts), `lockAvailableSeats`):

```sql
SELECT id, seat_number, status
  FROM show_seats
 WHERE show_id = $1 AND seat_number = ANY($2) AND status = 'available'
 ORDER BY seat_number
   FOR UPDATE;
```

**Mechanism:** row-level locks (`SELECT … FOR UPDATE`) plus PostgreSQL's READ COMMITTED re-check. If another transaction holds a requested seat, we block. When it commits, PostgreSQL re-evaluates our `WHERE` clause against the *newly committed* row version. A seat that was just confirmed no longer matches `status = 'available'`, so it is skipped and not locked. Every row that comes back is therefore available **and** locked by us until we commit. If we get back fewer rows than we asked for, we decline (`409`).

The write that follows, `UPDATE show_seats SET status='confirmed', reservation_id=$r WHERE id = ANY($ids) AND status = 'available'`, runs while we hold those locks. Its row count is asserted to equal the number requested.

**Why it is race-free:** the check ("is it available?") and the claim (the lock) are the same atomic database operation, and the lock is held until `COMMIT`. No other transaction can change those rows in between. This is not the unsafe *SELECT → check in app → UPDATE* pattern, because the SELECT itself takes the lock, and PostgreSQL re-validates the predicate after any wait.

**Safety nets** (tested by deliberately removing the locks, see §8):
- a partial unique index `reservation_seats (seat_id) WHERE active` makes a second active owner of a seat physically impossible;
- `CHECK ((status = 'available') = (reservation_id IS NULL))` keeps seat status and ownership consistent;
- the guarded `UPDATE` plus row-count assertion refuses to partially reserve.

**Fast decline.** A hot-seat storm means thousands of requests for a seat that is already sold. Before the transaction, one lock-free statement reads which requested seats are taken *and* whether this user already used this idempotency key. If a seat is taken and the key is new, it answers `409` immediately. It can only decline, never confirm. It reads seats and key in one snapshot, and a reservation commits both atomically, so a retry of the request that *won* always sees its key and falls through to the transaction, where it is replayed. In the 5,000-user burst this keeps nearly all losers out of the lock queue.

## 2. Multi-seat locking

Seats are always locked in one global order: `ORDER BY seat_number`, with the column declared `COLLATE "C"` so the order is byte-wise and identical on every machine. The service sorts seat labels the same way when normalizing the request.

Every writer takes locks in the same sequence:

```
user_show_quotas(user, show)  →  reservations(id) [cancel only]  →  show_seats by seat_number
```

A deadlock needs a cycle: T1 holds X and waits for Y while T2 holds Y and waits for X. With one total order, a transaction only ever waits for a lock that comes *after* everything it already holds, so no cycle can form. Concretely, `[A1, A2]` and `[A2, A1]` both lock A1 first. The second request waits on A1 and never holds A2 while waiting. The test *"opposite lock orders never deadlock into 5xx"* runs 200 such requests.

Two further points:
- Cancellation's seat lock (`WHERE reservation_id = $r … FOR UPDATE`) only touches seats owned by that reservation, also in seat order.
- Deadlock (`40P01`) and serialization (`40001`) errors are still retried, at most 3 attempts with jitter, as a backstop. They are never shown to clients.

Multi-seat requests are **all-or-nothing**. Any missing seat throws inside the transaction, which rolls back, so nothing is partially reserved.

## 3. Idempotency

- **Where stored:** `idempotency_keys (user_id, show_id, idempotency_key, request_hash, reservation_id, created_at)`, written in the *same transaction* as the reservation. Key and reservation commit or roll back together.
- **Unique constraint:** `UNIQUE (user_id, show_id, idempotency_key)`. Scoping by user means one user's key can never collide with, or replay, another user's reservation.
- **Request hashing:** `sha256("v1|" + show_id + "|" + sorted(seats).join(","))`, built from normalized fields, never from `JSON.stringify(body)`.
  - Property order, whitespace, unknown fields and seat order cannot cause false mismatches.
  - Duplicate seats are rejected before hashing.
  - The `v1` prefix allows the scheme to change later.
  - The user is not in the hash because it is already part of the key's scope.
- **Same key, same request:** returns the original reservation: `201`, the original body, and header `Idempotent-Replayed: true`. Nothing new is created. Counted as `reservations_declined_total{reason="idempotent_replay"}`.
- **Same key, different request:** `409 IDEMPOTENCY_CONFLICT`.
- **Concurrent retries:** the key is checked *after* taking the per-user row lock (step 1 of the transaction). So concurrent requests with the same key wait in line. The first creates the reservation and commits the key. Each later one gets the lock, and its next statement (READ COMMITTED takes a fresh snapshot per statement) sees the committed key and replays. The test *"100 concurrent retries"* checks for exactly one reservation and 99 replays. If the unique constraint ever fired anyway, the request is re-run once and then replays.
- **Declines are not stored:** a `409` rolls back, so a key binds only to a successful reservation, and a later retry is evaluated afresh. This was a deliberate choice. A client that got `SEAT_TAKEN` can retry the same key once the seat is released, instead of being stuck with a cached failure.

## 4. Per-user limit

The limit is checked against `user_show_quotas.seats_reserved` **while holding `SELECT … FOR UPDATE` on that user's row for that show**. Every reservation and every cancellation by that user for that show takes this lock first. So the limit check and the counter update are serialized per (user, show):

1. Ten concurrent requests from one user line up on the row lock.
2. Each one, in turn, reads the counter as committed by the previous one (READ COMMITTED, fresh snapshot after the wait).
3. Each checks `seats_reserved + n ≤ per_user_limit` and, if it succeeds, increments the counter in the same transaction.

There is no window between the count and the insert. The row is created race-free with `INSERT … ON CONFLICT DO NOTHING`: a concurrent first insert waits on the primary key and then does nothing. `CHECK (seats_reserved >= 0)` guards the counter, and the reconciliation helper asserts after every test that the counter equals the actual number of confirmed seats.

Other users are unaffected: they lock different rows. The test *"one user, 20 concurrent single-seat requests"* gets exactly 4 × `201` and 16 × `409 PER_USER_LIMIT`. Removing the `FOR UPDATE` makes it fail.

## 5. Cancellation

`POST /reservations/:id/cancel` runs one transaction ([`ReservationService.cancel`](src/modules/reservations/service.ts)):

1. Read the reservation. `404` if missing, `403` if `reservation.user_id ≠ token user`. These columns never change, so this read needs no lock.
2. Lock the owner's `user_show_quotas` row: the same lock and the same order as `reserve`.
3. `SELECT … FOR UPDATE` the reservation. If it is not `confirmed`, return `409 ALREADY_CANCELLED`. A concurrent second cancel waits here, then sees `cancelled`.
4. Lock and release only seats **still owned by this reservation**: `UPDATE show_seats SET status='available', reservation_id=NULL WHERE reservation_id = $r`. That predicate means a cancel can never overwrite or "resurrect" a seat that has since moved to another reservation. Released count must equal `seat_count`, or the transaction aborts.
5. Set `reservation_seats.active = false` (history is kept), decrement the user's counter, and mark the reservation `cancelled` with `cancelled_at`. Then `COMMIT`.

Released seats are immediately available to others. Tests cover: 10 concurrent cancels giving exactly 1 × `200` and 9 × `409`; cancelling, someone else re-booking, then cancelling again (`409`, and the seat stays with the new owner); and reserve/cancel churn under concurrency.

## 6. Consistency vs availability

The system chooses **consistency**. PostgreSQL is the only source of truth for seats, limits and idempotency keys. There is no cache and no "accept now, reconcile later" path. If the database is unavailable:

- `GET /health/ready` returns `503 {"status":"not_ready","database":"unavailable"}` using its own 2-connection pool, so a busy request pool cannot fake an outage. Load balancers stop routing to the instance. `/health/live` stays `200`, so the orchestrator does not restart-loop a healthy process.
- Reservation and cancel requests fail closed with `503 SERVICE_UNAVAILABLE` and `Retry-After: 1`. This also covers pool acquisition timeouts (`DB_POOL_ACQUIRE_TIMEOUT_MS`), `lock_timeout` and `statement_timeout`, so nothing hangs indefinitely. Because idempotency keys exist, a client can safely retry the *same* request later. Either nothing happened (transaction never committed) or the retry replays the committed result.
- The process does not crash: idle-client errors are logged. When PostgreSQL returns, the pool reconnects on its own, with no restart needed (verified by stopping and restarting the database container).

Accepting reservations without the database would mean deciding seat ownership without the only component that can decide it atomically. That would risk selling a seat twice or exceeding a limit, and selling a seat twice is far more expensive than a few seconds of `503`. A user can retry a `503`; a double sale needs a refund and an apology.

## 7. Observability

**Metrics** (`/metrics`, Prometheus), kept to what a person can read at a glance:
- seats: `seats_total`, `seats_available`, `seats_held`, `seats_confirmed`
- `reservations_confirmed_total`
- `reservations_declined_total{reason}`: `seat_taken`, `per_user_limit`, `idempotent_replay`, `idempotency_conflict` (plus `unknown_seats`, `show_not_found`, `validation`, `unavailable` when they occur)
- `reservations_cancelled_total`
- `http_responses_total{class=2xx|4xx|5xx}`
- `reservation_duration_seconds` (4 buckets)

Generic Node.js runtime metrics and per-route breakdowns were removed so the relevant numbers stand out.

The seat gauges are **queried from PostgreSQL at scrape time**, so they reconcile exactly with `GET /shows/:id` summed across shows, across restarts and replicas. In cluster mode the primary merges the workers' counters, so one scrape shows the whole server. No identifiers appear as labels.

**Logs:** JSON lines with `request_id` on every request-scoped line (incoming `X-Request-Id` propagated and echoed back), `event` names (`reservation_confirmed`, `reservation_declined` with `reason`, `reservation_idempotent_replay`, `reservation_cancelled`, `database_unavailable`, `unhandled_error`), and one `http_request` line per request. Expected `409`s log at `info`; only unexpected failures log at `error`. Tokens are redacted.

**Health:** liveness = process; readiness = database within 2 s.

**What pages someone at 2 AM** (symptoms users feel, not causes):

| Alert | Condition (5 min) | Why |
|---|---|---|
| Unexpected errors | `sum(rate(http_responses_total{class="5xx"}[5m])) / sum(rate(http_responses_total[5m])) > 1%` | 5xx should be ~0; contention is 409 by design |
| Database outage | `/health/ready` failing on all instances, or `reservations_declined_total{reason="unavailable"}` rising | Nobody can book |
| Booking latency | p99 `reservation_duration_seconds` > 2 s | Pool or lock saturation; users time out |
| **Invariant breach** | any `unhandled_error` log containing `Invariant violated`, or a unique-violation safety net firing | Should be impossible; means a bug in the locking protocol |

Ticket-level, not paging: a spike in `seat_taken` (popular show, expected), `idempotency_conflict` (client bug), or the seat gauges disappearing (database unreachable at scrape time).

## 8. AI usage

This section describes what happened in the AI-assisted sessions that produced this code. The final subsection, *What I verified and how I understand it*, was drafted with the AI assistant from my answers about what I checked, then reviewed by me. Its claims are mine to defend.

**Tool:** Claude Code (Anthropic, model Claude Opus 5.5) working in this repository, with shell access to run pnpm, Docker, the test suite and the burst script.

**What the AI did:**
- **Architecture brainstorming:** from my written brief, it proposed the schema, the locking protocol (per-(user, show) quota row as the serialization point; seats locked in `seat_number` order; key checked under the user lock), and the module layout. It listed design risks (hot-seat queueing, pool exhaustion, why not `SKIP LOCKED`/`NOWAIT`, per-process counters). It also raised four open decisions for me (see below) before writing code.
- **Code generation:** it wrote essentially all source, SQL, tests, the Dockerfile, the compose file, the burst script, the README and this write-up draft, committing in the requested incremental steps.
- **Debugging:**
  - Pinned TypeScript 6 because typescript-eslint did not support TS 7.
  - Configured pnpm 11 build-script approvals.
  - Fixed a test helper parsing `/metrics` text as JSON.
  - Migrated off deprecated Fastify logging options.
  - Moved the compose PostgreSQL host port after clashes with services on this machine.
- **Performance finding:** running the burst test locally, it observed that hot-seat losers drained the seat lock one app round-trip at a time (p50 ≈ 1.7 s for 5,000 requests). It then introduced the `status = 'available'` predicate on the `FOR UPDATE` and the single-snapshot fast-decline probe, re-ran the full suite and the burst test, and committed this as a separate `perf:` commit for review.
- **Test generation and verification:** it wrote the integration and concurrency suites, ran them repeatedly to check for flakiness, and ran "mutation" checks: temporarily removing `FOR UPDATE`, the guarded `UPDATE` and the partial unique index to confirm the tests then fail, then restoring the code.
- **Review:** an automated security review in the tool flagged `rejectUnauthorized: false` for database TLS. It was replaced by `DATABASE_SSL_MODE` (verify by default). The AI also reviewed the final transaction for lock-order cycles and foreign-key lock interactions.

**Decisions I made** (evidenced in the session):
- the brief itself: stack, the "no Redis/queues" constraint, the priority order, the required behaviours;
- pnpm as the package manager;
- approving the AI's proposed defaults for the four open questions:
  1. replays return `201` with `Idempotent-Replayed: true`;
  2. declined attempts do not bind an idempotency key;
  3. `POST /auth/dev-token` is exposed behind a flag;
  4. the deployment target was left generic.

### What I verified and how I understand it

**What I checked myself:**
- **Read the transaction code:** `ReservationService.reserve` and `cancel` in `src/modules/reservations/service.ts`, and the SQL they call in `repository.ts`. In particular I checked:
  - every writer takes the user's `user_show_quotas` row before any seat;
  - the idempotency lookup happens after that lock;
  - the seat lock includes `status = 'available'`;
  - cancel releases seats only `WHERE reservation_id = $r`.
- **Read the PostgreSQL documentation** on the READ COMMITTED isolation level (*Transaction Isolation* chapter). It describes how `UPDATE` / `SELECT … FOR UPDATE` behave when the target row was changed by a concurrent transaction: the command waits for that transaction. If it commits, PostgreSQL re-evaluates the `WHERE` condition against the updated row and skips the row if it no longer matches. The fast decline and the hot-seat behaviour both depend on this.
- **Ran the test suite and the burst script myself**, and saw the hot-seat storm produce exactly one `201`, with every other request getting `409` and no `5xx`.

**What I changed:**

> **TODO(author):** describe the change you made to the AI's proposal: what it was, why, and where it lives in the code or commit history. Delete this note once filled in.

**Why it is race-free.** There are two kinds of shared state, and each has exactly one place where a decision is made, protected by a row lock that is held until commit:

- *Seat ownership* is decided by `SELECT … WHERE status = 'available' … FOR UPDATE`.
  - If I get the row back, I hold its lock, so nobody else can confirm it before I commit.
  - If someone confirmed it while I was waiting, PostgreSQL re-checks the condition after their commit and does not return the row, so I decline.
  - The partial unique index on active `reservation_seats` would reject a second owner even if this logic were wrong.
- *A user's seat count* is only read and changed while holding that user's `user_show_quotas` row for the show.
  - All of one user's reservations and cancellations for a show queue on that row.
  - So the check "already reserved + requested ≤ limit" and the increment happen as one step, with no gap another request could use.
  - The idempotency key is checked under the same lock. A concurrent retry therefore waits for the first request, and then sees its committed key and replays.

**Why it is deadlock-free.** A deadlock needs two transactions each waiting for a lock the other holds. Every transaction takes its locks in the same order: the user's quota row first, then (cancel only) the reservation row, then seats sorted by `seat_number` in byte order. A transaction only ever waits for a lock that comes later in that order than everything it already holds. So two transactions can never wait on each other in a circle.

For example, `[A2, A1]` and `[A1, A2]` both try A1 first; the loser waits on A1 while holding nothing else it needs. Different users use different quota rows, so they only meet at the seats, and the seats are always taken in the same order. As a safety net, if PostgreSQL ever did report a deadlock, the transaction is retried a few times instead of returning an error.

## 9. What I'd do next

- **Time-boxed holds:** `held` status plus `hold_expires_at`, reserving as *hold → confirm* (payment). Expiry by a periodic `UPDATE … WHERE status='held' AND hold_expires_at < now()` sweep, or by treating expired holds as available inside the same locked query. No new infrastructure needed.
- **Real identity:** replace dev tokens with an OIDC/JWKS `AuthVerifier`, and add an organizer role for `POST /shows`.
- **Idempotency key retention:** a TTL (e.g. 24–72 h) with a cleanup job, and optionally caching declined responses if clients need strict replay of failures.
- **Operational hardening:** PgBouncer (transaction mode is compatible because each request uses one transaction), per-IP and per-user rate limiting at the edge, an OpenAPI spec generated from the Zod schemas, OpenTelemetry tracing with `request_id` correlation, and alert rules checked into the repo.
- **Load evidence on target infrastructure:** run the burst script from a separate machine against the deployed environment, and tune `DB_POOL_MAX`, the pool-acquire and lock timeouts against measured p99. Local numbers come from client, server and database sharing one laptop.
- **Read scaling** for `GET /shows/:id` on very large venues (pagination or a counts-only view) if needed. Correctness paths stay on the primary.
