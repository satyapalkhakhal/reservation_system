/**
 * Burst test against a live deployment. Zero dependencies: runs directly on
 * Node >= 22.18 / 24 (built-in TypeScript type stripping and fetch).
 *
 *   ./burst.sh https://your-app.example.com
 *   node scripts/burst.ts http://localhost:3000 --hot 5000 --concurrency 1000
 *
 * Tokens: by default obtained from POST /auth/dev-token (server needs
 * AUTH_DEV_TOKENS_ENABLED=true). Alternatively set BURST_JWT_SECRET (and
 * optionally BURST_JWT_ISSUER) to sign HS256 tokens locally.
 *
 * Uses only the public HTTP API. Exit code 0 = all checks passed.
 */
import { createHmac, randomUUID } from 'node:crypto';

// ---------- args ----------
const argv = process.argv.slice(2);
const BASE_URL = (argv.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '');
function flag(name: string, def: number): number {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
}
if (!BASE_URL) {
  console.error('usage: ./burst.sh <BASE_URL> [--hot 5000] [--seats 100] [--same-user 20] [--retries 50] [--overlap 500] [--concurrency 1000]');
  process.exit(2);
}
const HOT = flag('hot', 5000);
const SEATS = flag('seats', 100);
const SAME_USER = flag('same-user', 20);
const RETRIES = flag('retries', 50);
const OVERLAP = flag('overlap', 500);
const CONCURRENCY = flag('concurrency', 1000);
const RUN = randomUUID().slice(0, 8); // unique user ids per run

// ---------- http ----------
interface Result {
  status: number; // 0 = network error
  code?: string; // error.code from body
  body?: any;
  ms: number;
}

async function call(method: string, path: string, token?: string, body?: unknown): Promise<Result> {
  const started = performance.now();
  try {
    const res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    });
    const text = await res.text();
    let json: any;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = { raw: text.slice(0, 200) };
    }
    return { status: res.status, code: json?.error?.code, body: json, ms: performance.now() - started };
  } catch (err) {
    return { status: 0, code: `NETWORK:${(err as Error).name}`, ms: performance.now() - started };
  }
}

/** Run tasks with at most `limit` in flight. All are released together at start. */
async function runAll<T>(tasks: (() => Promise<T>)[], limit = CONCURRENCY): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const i = next++;
      results[i] = await tasks[i]!();
    }
  });
  await Promise.all(workers);
  return results;
}

// ---------- tokens ----------
const SECRET = process.env.BURST_JWT_SECRET;
const ISSUER = process.env.BURST_JWT_ISSUER ?? 'seat-reservation';
const tokenCache = new Map<string, string>();

function b64url(s: string | Buffer): string {
  return Buffer.from(s).toString('base64url');
}

async function token(userId: string): Promise<string> {
  const cached = tokenCache.get(userId);
  if (cached) return cached;
  let t: string;
  if (SECRET) {
    const now = Math.floor(Date.now() / 1000);
    const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = b64url(JSON.stringify({ sub: userId, iss: ISSUER, iat: now, exp: now + 3600 }));
    const sig = createHmac('sha256', SECRET).update(`${head}.${payload}`).digest('base64url');
    t = `${head}.${payload}.${sig}`;
  } else {
    const r = await call('POST', '/auth/dev-token', undefined, { user_id: userId });
    if (r.status !== 201) {
      throw new Error(
        `Could not get a token from /auth/dev-token (HTTP ${r.status}). ` +
          'Enable AUTH_DEV_TOKENS_ENABLED=true on the server or set BURST_JWT_SECRET.',
      );
    }
    t = r.body.access_token;
  }
  tokenCache.set(userId, t);
  return t;
}

async function prefetchTokens(userIds: string[]): Promise<void> {
  await runAll(userIds.map((u) => () => token(u)), 200);
}

// ---------- reporting ----------
interface Check {
  name: string;
  ok: boolean;
  detail: string;
}
const checks: Check[] = [];
function check(name: string, ok: boolean, detail: string): void {
  checks.push({ name, ok, detail });
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function summarize(title: string, results: Result[]): { s201: number; s5xx: number; net: number } {
  const by = new Map<string, number>();
  let s201 = 0;
  let s5xx = 0;
  let net = 0;
  for (const r of results) {
    if (r.status === 201) s201++;
    else if (r.status >= 500) s5xx++;
    else if (r.status === 0) net++;
    if (r.status !== 201) {
      const k = r.status === 0 ? r.code! : `${r.status} ${r.code ?? ''}`.trim();
      by.set(k, (by.get(k) ?? 0) + 1);
    }
  }
  const lat = results.map((r) => r.ms).sort((a, b) => a - b);
  console.log(`\n=== ${title} ===`);
  console.log(`Total requests: ${results.length}`);
  console.log(`201: ${s201}`);
  for (const [k, v] of [...by.entries()].sort()) console.log(`${k}: ${v}`);
  console.log(`5xx: ${s5xx}`);
  if (net) console.log(`network errors: ${net}`);
  console.log(`latency ms p50=${pct(lat, 50).toFixed(0)} p95=${pct(lat, 95).toFixed(0)} p99=${pct(lat, 99).toFixed(0)} max=${pct(lat, 100).toFixed(0)}`);
  return { s201, s5xx, net };
}

const seatNames = (n: number) => Array.from({ length: n }, (_, i) => `A${i + 1}`);

async function createShow(name: string, seats: string[], perUserLimit?: number): Promise<string> {
  const r = await call('POST', '/shows', await token(`burst-admin-${RUN}`), {
    name,
    seats,
    price_paise: 25000,
    ...(perUserLimit ? { per_user_limit: perUserLimit } : {}),
  });
  if (r.status !== 201) throw new Error(`create show failed: HTTP ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.id;
}

function reserve(showId: string, userId: string, seats: string[], key = randomUUID()): () => Promise<Result> {
  return async () => call('POST', `/shows/${showId}/reserve`, await token(userId), { seats, idempotency_key: key });
}

// ---------- scenarios ----------
async function main(): Promise<void> {
  console.log(`Burst test against ${BASE_URL} (run ${RUN})`);
  const ready = await call('GET', '/health/ready');
  console.log(`/health/ready -> ${ready.status} ${JSON.stringify(ready.body)}`);
  if (ready.status !== 200) throw new Error('service is not ready');

  const showsToReconcile: { id: string; label: string; total: number }[] = [];

  // 1. Hot-seat storm: HOT distinct users, same seat.
  {
    const showId = await createShow(`burst-hot-${RUN}`, seatNames(SEATS));
    showsToReconcile.push({ id: showId, label: 'hot-seat', total: SEATS });
    const users = Array.from({ length: HOT }, (_, i) => `hot-${RUN}-${i}`);
    await prefetchTokens(users);
    const results = await runAll(users.map((u) => reserve(showId, u, ['A12'])));
    const { s201, s5xx, net } = summarize(`1. Hot-seat storm: ${HOT} users -> seat A12`, results);
    const seatTaken = results.filter((r) => r.status === 409 && r.code === 'SEAT_TAKEN').length;
    check('hot-seat: exactly one 201', s201 === 1, `201=${s201}`);
    check('hot-seat: all others 409 SEAT_TAKEN', seatTaken === HOT - 1, `409 seat_taken=${seatTaken}/${HOT - 1}`);
    check('hot-seat: zero 5xx / network errors', s5xx === 0 && net === 0, `5xx=${s5xx} net=${net}`);
  }

  // 2. Same user, many concurrent requests for different seats.
  {
    const showId = await createShow(`burst-same-user-${RUN}`, seatNames(Math.max(SAME_USER, 4)));
    const show = await call('GET', `/shows/${showId}`);
    const limit = show.body.per_user_limit as number;
    showsToReconcile.push({ id: showId, label: 'same-user', total: Math.max(SAME_USER, 4) });
    const user = `greedy-${RUN}`;
    const results = await runAll(seatNames(SAME_USER).map((s) => reserve(showId, user, [s])));
    const { s201, s5xx } = summarize(`2. Same-user concurrency: 1 user, ${SAME_USER} parallel requests (limit ${limit})`, results);
    const limited = results.filter((r) => r.status === 409 && r.code === 'PER_USER_LIMIT').length;
    check('same-user: confirmed seats == per-user limit', s201 === Math.min(limit, SAME_USER), `201=${s201} limit=${limit}`);
    check('same-user: rest are 409 PER_USER_LIMIT', limited === SAME_USER - s201, `409 per_user_limit=${limited}`);
    check('same-user: zero 5xx', s5xx === 0, `5xx=${s5xx}`);
  }

  // 3. Idempotency: concurrent retries with one key, then same key + different body.
  {
    const showId = await createShow(`burst-idem-${RUN}`, seatNames(10));
    showsToReconcile.push({ id: showId, label: 'idempotency', total: 10 });
    const user = `retry-${RUN}`;
    const key = randomUUID();
    const results = await runAll(Array.from({ length: RETRIES }, () => reserve(showId, user, ['A1', 'A2'], key)));
    const { s201, s5xx } = summarize(`3. Idempotency: ${RETRIES} concurrent retries, same key`, results);
    const ids = new Set(results.filter((r) => r.status === 201).map((r) => r.body.reservation_id));
    check('idempotency: all retries 201', s201 === RETRIES, `201=${s201}/${RETRIES}`);
    check('idempotency: exactly one reservation id', ids.size === 1, `distinct reservation ids=${ids.size}`);
    check('idempotency: zero 5xx', s5xx === 0, `5xx=${s5xx}`);
    const conflict = await reserve(showId, user, ['A3'], key)();
    console.log(`same key + different body -> ${conflict.status} ${conflict.code}`);
    check('idempotency: different body -> 409 IDEMPOTENCY_CONFLICT', conflict.status === 409 && conflict.code === 'IDEMPOTENCY_CONFLICT', `${conflict.status} ${conflict.code}`);
    const state = await call('GET', `/shows/${showId}`);
    check('idempotency: only 2 seats confirmed', state.body.counts.confirmed === 2, `confirmed=${state.body.counts.confirmed}`);
  }

  // 4. Overlapping multi-seat requests (all-or-nothing + lock ordering).
  {
    const n = 20;
    const showId = await createShow(`burst-overlap-${RUN}`, seatNames(n));
    showsToReconcile.push({ id: showId, label: 'overlap', total: n });
    const users = Array.from({ length: OVERLAP }, (_, i) => `ov-${RUN}-${i}`);
    await prefetchTokens(users);
    const tasks = users.map((u, i) => {
      const size = 1 + (i % 3);
      const start = Math.floor(Math.random() * (n - size + 1));
      const seats = seatNames(n).slice(start, start + size);
      return reserve(showId, u, i % 2 ? seats : [...seats].reverse());
    });
    const results = await runAll(tasks);
    const { s5xx } = summarize(`4. Overlapping multi-seat: ${OVERLAP} users, 1-3 adjacent seats each`, results);
    const won = results.filter((r) => r.status === 201).flatMap((r) => r.body.seats as string[]);
    const state = await call('GET', `/shows/${showId}`);
    check('overlap: no seat sold twice', new Set(won).size === won.length, `seats won=${won.length} distinct=${new Set(won).size}`);
    check('overlap: confirmed seats == seats in 201 responses', state.body.counts.confirmed === won.length, `confirmed=${state.body.counts.confirmed} won=${won.length}`);
    check('overlap: zero 5xx', s5xx === 0, `5xx=${s5xx}`);
  }

  // 5. Final reconciliation from the public API.
  console.log('\n=== Reconciliation ===');
  for (const s of showsToReconcile) {
    const r = await call('GET', `/shows/${s.id}`);
    const { available, held, confirmed } = r.body.counts;
    const sum = available + held + confirmed;
    const statusSum = r.body.seats.length;
    const ok = sum === r.body.total_seats && r.body.total_seats === s.total && statusSum === s.total;
    console.log(
      `${s.label.padEnd(12)} total=${r.body.total_seats} available=${available} held=${held} confirmed=${confirmed} sum=${sum} ${ok ? 'PASS' : 'FAIL'}`,
    );
    check(`reconcile ${s.label}: available+held+confirmed == total`, ok, `sum=${sum} total=${r.body.total_seats}`);
  }

  // Informational: server-side counters (cumulative per instance since start).
  try {
    const text = await (await fetch(`${BASE_URL}/metrics`, { signal: AbortSignal.timeout(10_000) })).text();
    const wanted = /^(reservations_confirmed_total|reservations_declined_total|seats_available|seats_held|seats_confirmed|seats_total) /;
    const lines = text.split('\n').filter((l) => wanted.test(l.replace(/\{.*\}/, '')));
    console.log('\n=== /metrics (server-wide) ===');
    for (const l of lines) console.log(l);
  } catch {
    console.log('\n(/metrics not reachable)');
  }

  console.log('\n=== Checks ===');
  for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'}  ${c.name}  (${c.detail})`);
  const failed = checks.filter((c) => !c.ok).length;
  console.log(`\n${failed === 0 ? 'ALL CHECKS PASSED' : `${failed} CHECK(S) FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err: unknown) => {
  console.error(`burst test aborted: ${(err as Error).message}`);
  process.exit(1);
});
