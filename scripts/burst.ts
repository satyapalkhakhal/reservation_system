/**
 * Burst test against a live deployment. Zero dependencies: runs directly on
 * Node >= 22.18 / 24 (built-in TypeScript type stripping and fetch).
 *
 *   ./burst.sh https://your-app.example.com
 *   node scripts/burst.ts http://localhost:3000 --hot 5000 --concurrency 1000
 *   ./burst.sh https://your-app.example.com --stampede 25000 --concurrency 2000
 *
 * Tokens: by default obtained from POST /auth/dev-token (server needs
 * AUTH_DEV_TOKENS_ENABLED=true). Alternatively set BURST_JWT_SECRET (and
 * optionally BURST_JWT_ISSUER) to sign HS256 tokens locally.
 *
 * Uses only the public HTTP API. Exit code 0 = all checks passed.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { availableParallelism } from 'node:os';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

// ---------- args ----------
const argv = process.argv.slice(2);
const BASE_URL: string = isMainThread
  ? (argv.find((a) => !a.startsWith('--')) ?? '').replace(/\/+$/, '')
  : (workerData as WorkerInput).baseUrl;
function flag(name: string, def: number): number {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : def;
}
if (isMainThread && !BASE_URL) {
  console.error(
    'usage: ./burst.sh <BASE_URL> [--hot 5000] [--seats 100] [--same-user 20] [--retries 50] [--overlap 500]\n' +
      '                  [--stampede 0] [--hot-seats 5] [--hall 500] [--concurrency 1000]',
  );
  process.exit(2);
}
const HOT = flag('hot', 5000);
const SEATS = flag('seats', 100);
const SAME_USER = flag('same-user', 20);
const RETRIES = flag('retries', 50);
const OVERLAP = flag('overlap', 500);
const CONCURRENCY = isMainThread ? flag('concurrency', 1000) : (workerData as WorkerInput).concurrency;
// A single JS thread saturates at a few thousand concurrent HTTPS requests and
// then measures its own queue instead of the server. Large scenarios are
// spread across worker threads (each with its own connections and event loop).
const WORKERS = flag('workers', Math.max(1, Math.min(8, availableParallelism() - 1)));
const STAMPEDE = flag('stampede', 0); // total requests in the on-sale stampede (0 = skip)
const HOT_SEATS = flag('hot-seats', 5);
const HALL = flag('hall', 500);
const RUN = randomUUID().slice(0, 8); // unique user ids per run

/**
 * process.exit() right after console.log can drop the last lines when stdout
 * is a pipe (writes to pipes are asynchronous). Exit only once stdout and
 * stderr have flushed everything written so far.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  process.stdout.write('', () => process.stderr.write('', () => process.exit(code)));
}

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
    // fetch wraps the real reason (connect timeout, reset, ...) in err.cause.
    const cause = (err as { cause?: { code?: string; name?: string } }).cause;
    const why = cause?.code ?? cause?.name ?? (err as Error).name;
    return { status: 0, code: `NETWORK:${why}`, ms: performance.now() - started };
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

// ---------- worker threads ----------
interface Req {
  method: string;
  path: string;
  token?: string;
  body?: unknown;
}
interface WorkerInput {
  baseUrl: string;
  concurrency: number;
  reqs: Req[];
}

/**
 * Fire requests with CONCURRENCY total in flight. Large batches are split
 * across WORKERS threads; results come back in the original order.
 */
async function fire(reqs: Req[]): Promise<Result[]> {
  const workers = reqs.length >= 2000 ? Math.min(WORKERS, reqs.length) : 1;
  if (workers <= 1) return runAll(reqs.map((r) => () => call(r.method, r.path, r.token, r.body)));

  const chunks: { idx: number[]; reqs: Req[] }[] = Array.from({ length: workers }, () => ({ idx: [], reqs: [] }));
  reqs.forEach((r, i) => {
    const c = chunks[i % workers]!;
    c.idx.push(i);
    c.reqs.push(r);
  });
  const perWorker = Math.max(1, Math.ceil(CONCURRENCY / workers));
  const out = new Array<Result>(reqs.length);
  await Promise.all(
    chunks.map(
      (c) =>
        new Promise<void>((resolve, reject) => {
          const w = new Worker(new URL(import.meta.url), {
            workerData: { baseUrl: BASE_URL, concurrency: perWorker, reqs: c.reqs } satisfies WorkerInput,
            execArgv: ['--disable-warning=ExperimentalWarning'],
          });
          w.once('message', (results: Result[]) => {
            results.forEach((r, j) => (out[c.idx[j]!] = r));
            resolve();
          });
          w.once('error', reject);
          w.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker exited with ${code}`))));
        }),
    ),
  );
  return out;
}

async function workerMain(): Promise<void> {
  const { reqs } = workerData as WorkerInput;
  const results = await runAll(reqs.map((r) => () => call(r.method, r.path, r.token, r.body)));
  parentPort!.postMessage(results);
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

async function metricValue(name: string): Promise<number | undefined> {
  try {
    const text = await (await fetch(`${BASE_URL}/metrics`, { signal: AbortSignal.timeout(30_000) })).text();
    const line = text.split('\n').find((l) => l.startsWith(`${name} `));
    return line ? Number(line.split(' ')[1]) : undefined;
  } catch {
    return undefined;
  }
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j]!, arr[i]!];
  }
  return arr;
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

function reserve(showId: string, userId: string, seats: string[], key: string = randomUUID()): () => Promise<Result> {
  return async () => call('POST', `/shows/${showId}/reserve`, await token(userId), { seats, idempotency_key: key });
}

/** Same request as reserve(), as plain data for worker threads (token must be prefetched). */
async function reserveReq(showId: string, userId: string, seats: string[], key: string = randomUUID()): Promise<Req> {
  return { method: 'POST', path: `/shows/${showId}/reserve`, token: await token(userId), body: { seats, idempotency_key: key } };
}

// ---------- scenarios ----------
async function main(): Promise<void> {
  console.log(`Burst test against ${BASE_URL} (run ${RUN}, concurrency ${CONCURRENCY}, worker threads ${WORKERS})`);
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
    const results = await fire(await Promise.all(users.map((u) => reserveReq(showId, u, ['A12']))));
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

  // 5. On-sale stampede: one fresh show, STAMPEDE requests fired together.
  //    ~50% on a handful of hot seats, ~30% spread over the rest of the hall,
  //    ~20% exact retries (same user + key + body) of other requests.
  //    The show is polled DURING the storm to check the invariant live.
  if (STAMPEDE > 0) {
    const hall = seatNames(HALL);
    const hot = hall.slice(0, HOT_SEATS);
    const cold = hall.slice(HOT_SEATS);
    const showId = await createShow(`burst-stampede-${RUN}`, hall);
    showsToReconcile.push({ id: showId, label: 'stampede', total: HALL });

    interface Spec { user: string; seats: string[]; key: string; kind: 'hot' | 'cold' | 'retry' }
    const originals: Spec[] = [];
    const nOriginal = Math.round(STAMPEDE * 0.8);
    for (let i = 0; i < nOriginal; i++) {
      const isHot = i < Math.round(STAMPEDE * 0.5);
      const seat = isHot ? hot[i % hot.length]! : cold[Math.floor(Math.random() * cold.length)]!;
      originals.push({ user: `st-${RUN}-${i}`, seats: [seat], key: randomUUID(), kind: isHot ? 'hot' : 'cold' });
    }
    const retries: Spec[] = Array.from({ length: STAMPEDE - nOriginal }, () => ({
      ...originals[Math.floor(Math.random() * originals.length)]!,
      kind: 'retry' as const,
    }));
    const specs = shuffle([...originals, ...retries]);

    console.log(`\n(stampede: fetching ${originals.length} user tokens...)`);
    await prefetchTokens(originals.map((o) => o.user));
    const confirmedBefore = (await metricValue('reservations_confirmed_total')) ?? NaN;

    // Live reconciliation poller.
    let done = false;
    const samples: { sum: number; total: number; confirmed: number; status: number }[] = [];
    const poller = (async () => {
      while (!done) {
        const r = await call('GET', `/shows/${showId}`);
        if (r.status === 200) {
          const c = r.body.counts;
          samples.push({ sum: c.available + c.held + c.confirmed, total: r.body.total_seats, confirmed: c.confirmed, status: 200 });
        } else {
          samples.push({ sum: -1, total: -1, confirmed: -1, status: r.status });
        }
        await new Promise((res) => setTimeout(res, 250));
      }
    })();

    const started = performance.now();
    const reqs = await Promise.all(specs.map((sp) => reserveReq(showId, sp.user, sp.seats, sp.key)));
    const results = await fire(reqs);
    const elapsed = (performance.now() - started) / 1000;
    done = true;
    await poller;

    const { s5xx, net } = summarize(
      `5. On-sale stampede: ${STAMPEDE} requests, ${HOT_SEATS} hot seats, ${HALL}-seat hall, ~20% retries`,
      results,
    );
    console.log(`wall time ${elapsed.toFixed(1)}s, ~${Math.round(STAMPEDE / elapsed)} req/s`);

    // Per seat: which reservation ids won it.
    const winnersBySeat = new Map<string, Set<string>>();
    const reservationIds = new Set<string>();
    for (const r of results) {
      if (r.status !== 201) continue;
      reservationIds.add(r.body.reservation_id);
      for (const seat of r.body.seats as string[]) {
        if (!winnersBySeat.has(seat)) winnersBySeat.set(seat, new Set());
        winnersBySeat.get(seat)!.add(r.body.reservation_id);
      }
    }
    const doubleSold = [...winnersBySeat.entries()].filter(([, ids]) => ids.size > 1).map(([seat]) => seat);
    const hotWinners = hot.map((seat) => winnersBySeat.get(seat)?.size ?? 0);

    // Idempotency: every request sharing a key must get the same outcome.
    const byKey = new Map<string, Set<string>>();
    specs.forEach((sp, i) => {
      const r = results[i]!;
      const outcome = r.status === 201 ? `201:${r.body.reservation_id}` : `${r.status}:${r.code}`;
      if (!byKey.has(sp.key)) byKey.set(sp.key, new Set());
      byKey.get(sp.key)!.add(outcome);
    });
    const inconsistentKeys = [...byKey.values()].filter((o) => o.size > 1).length;
    const retriedKeys = new Set(retries.map((r) => r.key)).size;

    const state = await call('GET', `/shows/${showId}`);
    const confirmedAfter = (await metricValue('reservations_confirmed_total')) ?? NaN;
    const badSamples = samples.filter((x) => x.status !== 200 || x.sum !== x.total);
    let monotonic = true;
    for (let i = 1; i < samples.length; i++) if (samples[i]!.confirmed < samples[i - 1]!.confirmed) monotonic = false;

    console.log(`hot seat winners: ${hot.map((s, i) => `${s}=${hotWinners[i]}`).join(' ')}`);
    console.log(`distinct reservations=${reservationIds.size} seats confirmed=${state.body.counts.confirmed} retried keys=${retriedKeys}`);
    console.log(`live reconciliation samples during burst: ${samples.length} (bad=${badSamples.length})`);

    check('stampede: zero 5xx / network errors', s5xx === 0 && net === 0, `5xx=${s5xx} net=${net}`);
    check('stampede: each hot seat has exactly one winner', hotWinners.every((n) => n === 1), hotWinners.join(','));
    check('stampede: no seat sold twice', doubleSold.length === 0, `double-sold=${doubleSold.length}`);
    check(
      'stampede: confirmed seats == distinct reservations in 201s',
      state.body.counts.confirmed === reservationIds.size,
      `confirmed=${state.body.counts.confirmed} reservations=${reservationIds.size}`,
    );
    check('stampede: same key -> same outcome for every retry', inconsistentKeys === 0, `inconsistent keys=${inconsistentKeys}/${byKey.size}`);
    check(
      'stampede: invariant held in every live sample during the burst',
      samples.length > 0 && badSamples.length === 0,
      `samples=${samples.length} bad=${badSamples.length}`,
    );
    check('stampede: confirmed count never decreased during the burst', monotonic, `samples=${samples.length}`);
    // An unreadable /metrics is a failure, not a skipped check.
    const metricsReadable = Number.isFinite(confirmedBefore) && Number.isFinite(confirmedAfter);
    check(
      'stampede: metrics reservations_confirmed_total moved by exactly the new reservations',
      metricsReadable && confirmedAfter - confirmedBefore === reservationIds.size,
      metricsReadable
        ? `delta=${confirmedAfter - confirmedBefore} reservations=${reservationIds.size}`
        : '/metrics unreadable or missing reservations_confirmed_total',
    );
  }

  // 6. Final reconciliation from the public API.
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
  exitAfterFlush(failed === 0 ? 0 : 1);
}

if (isMainThread) {
  main().catch((err: unknown) => {
    console.error(`burst test aborted: ${(err as Error).message}`);
    exitAfterFlush(1);
  });
} else {
  void workerMain();
}
