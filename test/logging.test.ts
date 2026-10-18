import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createShow, key, startHarness, type Harness } from './helpers/harness.js';

describe('structured logging', () => {
  const lines: Record<string, any>[] = [];
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness({ LOG_LEVEL: 'info' }, { write: (l: string) => void lines.push(JSON.parse(l)) });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('emits JSON with request_id, redacts tokens, logs declines at info', async () => {
    const show = await createShow(h, { seats: 2 });
    const token = await h.token('log-user');
    const reserve = (requestId: string) =>
      fetch(`${h.baseUrl}/shows/${show.id}/reserve`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'x-request-id': requestId },
        body: JSON.stringify({ seats: ['A1'], idempotency_key: key() }),
      });

    const ok = await reserve('req-ok-1');
    expect(ok.status).toBe(201);
    expect(ok.headers.get('x-request-id')).toBe('req-ok-1');
    const declined = await reserve('req-declined-1');
    expect(declined.status).toBe(409);

    const confirmed = lines.find((l) => l.event === 'reservation_confirmed' && l.request_id === 'req-ok-1');
    expect(confirmed).toMatchObject({ level: 'info', show_id: show.id, user_id: 'log-user', seats: ['A1'] });
    expect(confirmed?.reservation_id).toBeTypeOf('string');

    const decline = lines.find((l) => l.event === 'reservation_declined' && l.request_id === 'req-declined-1');
    expect(decline).toMatchObject({ level: 'info', reason: 'seat_taken' });

    const access = lines.find((l) => l.event === 'http_request' && l.request_id === 'req-declined-1');
    expect(access).toMatchObject({ level: 'info', status_code: 409, route: '/shows/:showId/reserve' });

    expect(lines.some((l) => l.level === 'error')).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});
