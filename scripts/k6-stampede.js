/**
 * On-sale stampede load test with Grafana k6 (no install: runs in Docker).
 *
 *   docker run --rm -i --network host \
 *     -e BASE_URL=https://reservation.example.com -e JWT_SECRET=... \
 *     -e REQUESTS=25000 -e VUS=5000 \
 *     grafana/k6 run - < scripts/k6-stampede.js
 *
 * Traffic (like burst.ts --stampede): one fresh show; new requests target a
 * few hot seats (~62%) or the rest of the hall (~38%); ~20% of requests are
 * exact retries (same user, key and body) of the virtual user's previous one.
 *
 * Load modes:
 *   concurrency (default): REQUESTS total, VUS in flight at once
 *   rate:                  RATE reservations/second for DURATION (e.g. 60s)
 *
 * Tokens: with JWT_SECRET (the server's), HS256 tokens are signed locally:
 * one user per new request, no extra traffic. Without it, each virtual user
 * fetches one token from POST /auth/dev-token (then each VU is one user, so
 * the per-user limit also comes into play).
 *
 * Pass/fail thresholds: zero 5xx, zero connection failures, and every
 * reservation answered 201 or 409. Correctness across requests (one winner
 * per seat, idempotency consistency, live invariant) is checked by burst.ts.
 *
 * Env: BASE_URL (required), JWT_SECRET, JWT_ISSUER (seat-reservation),
 * REQUESTS (25000), VUS (5000), RATE, DURATION (60s), HOT_SEATS (5),
 * HALL (500), RETRY_RATIO (0.2), INSECURE=1 (skip TLS verify; localhost only).
 */
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';
import crypto from 'k6/crypto';
import encoding from 'k6/encoding';
import exec from 'k6/execution';

const BASE_URL = (__ENV.BASE_URL || '').replace(/\/+$/, '');
if (!BASE_URL) throw new Error('BASE_URL is required, e.g. -e BASE_URL=https://reservation.example.com');
const SECRET = __ENV.JWT_SECRET || '';
const ISSUER = __ENV.JWT_ISSUER || 'seat-reservation';
const REQUESTS = Number(__ENV.REQUESTS || 25000);
const VUS = Number(__ENV.VUS || 5000);
const RATE = Number(__ENV.RATE || 0);
const DURATION = __ENV.DURATION || '60s';
const HOT_SEATS = Number(__ENV.HOT_SEATS || 5);
const HALL = Number(__ENV.HALL || 500);
const RETRY_RATIO = Number(__ENV.RETRY_RATIO || 0.2);
const HOT_SHARE = 0.625; // of new requests; with 20% retries ≈ 50% of all traffic

const scenario = RATE
  ? {
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      preAllocatedVUs: Math.max(100, Math.min(VUS, RATE * 10)),
      maxVUs: VUS,
    }
  : { executor: 'shared-iterations', vus: VUS, iterations: REQUESTS, maxDuration: '15m' };

export const options = {
  scenarios: { stampede: scenario },
  setupTimeout: '2m',
  insecureSkipTLSVerify: __ENV.INSECURE === '1',
  discardResponseBodies: false,
  summaryTrendStats: ['p(50)', 'p(95)', 'p(99)', 'max'],
  thresholds: {
    reserve_5xx: ['count==0'],
    reserve_network_errors: ['count==0'],
    'checks{check:reserve answered 201 or 409}': ['rate==1'],
    // Not a pass/fail bar; makes the summary show reservation latency alone.
    'http_req_duration{name:reserve}': ['max>=0'],
  },
};

// 409 is an expected domain outcome, not a failed request.
http.setResponseCallback(http.expectedStatuses(201, 409));

const confirmed = new Counter('reserve_201_confirmed');
const replayed = new Counter('reserve_201_replayed');
const seatTaken = new Counter('reserve_409_seat_taken');
const perUserLimit = new Counter('reserve_409_per_user_limit');
const otherDecline = new Counter('reserve_4xx_other');
const serverErrors = new Counter('reserve_5xx');
const networkErrors = new Counter('reserve_network_errors');

const seats = Array.from({ length: HALL }, (_, i) => `A${i + 1}`);

function signToken(userId) {
  const now = Math.floor(Date.now() / 1000);
  const head = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');
  const body = encoding.b64encode(JSON.stringify({ sub: userId, iss: ISSUER, iat: now, exp: now + 3600 }), 'rawurl');
  return `${head}.${body}.${crypto.hmac('sha256', SECRET, `${head}.${body}`, 'base64rawurl')}`;
}

function devToken(userId) {
  const res = http.post(`${BASE_URL}/auth/dev-token`, JSON.stringify({ user_id: userId }), {
    headers: { 'content-type': 'application/json' },
    tags: { name: 'dev-token' },
  });
  if (res.status !== 201) {
    throw new Error(`dev-token failed (HTTP ${res.status}); set JWT_SECRET or enable AUTH_DEV_TOKENS_ENABLED`);
  }
  return res.json('access_token');
}

const tokenFor = (userId) => (SECRET ? signToken(userId) : devToken(userId));

export function setup() {
  const run = `${Date.now().toString(36)}`;
  const res = http.post(
    `${BASE_URL}/shows`,
    JSON.stringify({ name: `k6-stampede-${run}`, seats, price_paise: 25000 }),
    { headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor(`k6-admin-${run}`)}` } },
  );
  if (res.status !== 201) throw new Error(`create show failed: HTTP ${res.status} ${res.body}`);
  const showId = res.json('id');
  console.log(`show ${showId}: ${HALL} seats, ${HOT_SEATS} hot; ${RATE ? `${RATE} req/s for ${DURATION}` : `${REQUESTS} requests, ${VUS} in flight`}`);
  return { run, showId };
}

// Per-VU state (each virtual user has its own JS runtime).
let vuToken = null;
let last = null;

export default function (data) {
  const vu = exec.vu.idInTest;
  let req;
  if (last && Math.random() < RETRY_RATIO) {
    req = last; // exact retry: same user, key and body
  } else {
    const n = exec.scenario.iterationInTest;
    const seat = Math.random() < HOT_SHARE ? seats[n % HOT_SEATS] : seats[HOT_SEATS + Math.floor(Math.random() * (HALL - HOT_SEATS))];
    let token;
    if (SECRET) {
      token = signToken(`k6-${data.run}-${n}`); // one user per new request
    } else {
      vuToken = vuToken || devToken(`k6-${data.run}-vu${vu}`); // one user per VU
      token = vuToken;
    }
    req = { token, body: JSON.stringify({ seats: [seat], idempotency_key: `${data.run}-${vu}-${n}` }) };
    last = req;
  }

  const res = http.post(`${BASE_URL}/shows/${data.showId}/reserve`, req.body, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${req.token}` },
    tags: { name: 'reserve' },
    timeout: '120s',
  });

  check(res, { 'reserve answered 201 or 409': (r) => r.status === 201 || r.status === 409 });
  if (res.status === 0) networkErrors.add(1);
  else if (res.status >= 500) serverErrors.add(1);
  else if (res.status === 201) (res.headers['Idempotent-Replayed'] ? replayed : confirmed).add(1);
  else if (res.status === 409) {
    const code = res.json('error.code');
    (code === 'SEAT_TAKEN' ? seatTaken : code === 'PER_USER_LIMIT' ? perUserLimit : otherDecline).add(1);
  } else otherDecline.add(1);
}

export function teardown(data) {
  const res = http.get(`${BASE_URL}/shows/${data.showId}`, { responseCallback: http.expectedStatuses(200) });
  if (res.status !== 200) {
    console.error(`final show state unavailable: HTTP ${res.status}`);
    return;
  }
  const { available, held, confirmed: conf } = res.json('counts');
  const total = res.json('total_seats');
  const hot = res.json('seats').filter((s) => seats.indexOf(s.seat) < HOT_SEATS);
  const ok = available + held + conf === total;
  console.log(
    `reconciliation: total=${total} available=${available} held=${held} confirmed=${conf} sum=${available + held + conf} ${ok ? 'PASS' : 'FAIL'}; ` +
      `hot seats confirmed=${hot.filter((s) => s.status === 'confirmed').length}/${HOT_SEATS}`,
  );
  check(res, { 'reconciliation: available+held+confirmed == total': () => ok });
}
