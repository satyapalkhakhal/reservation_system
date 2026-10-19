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

    // Exactly one line per request, carrying both HTTP and domain fields.
    const okLines = lines.filter((l) => l.request_id === 'req-ok-1');
    expect(okLines).toHaveLength(1);
    expect(okLines[0]).toMatchObject({
      level: 'info',
      event: 'reservation_confirmed',
      show_id: show.id,
      user_id: 'log-user',
      seats: ['A1'],
      status_code: 201,
      route: '/shows/:showId/reserve',
    });
    expect(okLines[0]!.reservation_id).toBeTypeOf('string');
    expect(okLines[0]!.duration_ms).toBeTypeOf('number');

    const declinedLines = lines.filter((l) => l.request_id === 'req-declined-1');
    expect(declinedLines).toHaveLength(1);
    expect(declinedLines[0]).toMatchObject({
      level: 'info',
      event: 'reservation_declined',
      reason: 'seat_taken',
      status_code: 409,
      route: '/shows/:showId/reserve',
      user_id: 'log-user',
    });

    expect(lines.some((l) => l.level === 'error')).toBe(false);
    expect(JSON.stringify(lines)).not.toContain(token);
  });
});
