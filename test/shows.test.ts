import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { api, startHarness, type Harness } from './helpers/harness.js';

let h: Harness;
let token: string;
beforeAll(async () => {
  h = await startHarness();
  token = await h.token('organizer');
});
afterAll(async () => {
  await h?.close();
});

describe('POST /shows', () => {
  it('creates a show with all seats available and default per-user limit', async () => {
    const res = await api(h, 'POST', '/shows', {
      token,
      body: { name: 'friday-night', seats: ['A1', 'A2', 'A3', 'A4'], price_paise: 25000 },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'friday-night',
      price_paise: 25000,
      per_user_limit: 4,
      total_seats: 4,
      counts: { available: 4, held: 0, confirmed: 0 },
    });
    expect(res.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.body.seats).toEqual(['A1', 'A2', 'A3', 'A4'].map((seat) => ({ seat, status: 'available' })));
  });

  it('accepts a custom per_user_limit', async () => {
    const res = await api(h, 'POST', '/shows', {
      token,
      body: { name: 'x', seats: ['A1'], price_paise: 100, per_user_limit: 2 },
    });
    expect(res.status).toBe(201);
    expect(res.body.per_user_limit).toBe(2);
  });

  it.each([
    [{ name: 'x', seats: ['A1'], price_paise: 250.5 }, 'fractional money'],
    [{ name: 'x', seats: ['A1'], price_paise: '25000' }, 'string money'],
    [{ name: 'x', seats: ['A1'], price_paise: -1 }, 'negative money'],
    [{ name: 'x', seats: [], price_paise: 1 }, 'no seats'],
    [{ name: 'x', seats: ['A1', 'A1'], price_paise: 1 }, 'duplicate seats'],
    [{ name: 'x', seats: ['A 1'], price_paise: 1 }, 'invalid seat label'],
    [{ name: '', seats: ['A1'], price_paise: 1 }, 'empty name'],
  ])('rejects invalid input with 400 (%#: %s)', async (body, _why) => {
    const res = await api(h, 'POST', '/shows', { token, body });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('requires authentication', async () => {
    const res = await api(h, 'POST', '/shows', { body: { name: 'x', seats: ['A1'], price_paise: 1 } });
    expect(res.status).toBe(401);
  });
});

describe('GET /shows/:id', () => {
  it('returns 404 for an unknown show and 400 for a malformed id', async () => {
    expect((await api(h, 'GET', '/shows/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await api(h, 'GET', '/shows/not-a-uuid')).status).toBe(400);
  });

  it('lists seats in human order (A2 before A10)', async () => {
    const created = await api(h, 'POST', '/shows', {
      token,
      body: { name: 'order', seats: ['A10', 'B1', 'A2', 'A1'], price_paise: 1 },
    });
    const res = await api(h, 'GET', `/shows/${created.body.id}`);
    expect(res.body.seats.map((s: any) => s.seat)).toEqual(['A1', 'A2', 'A10', 'B1']);
  });
});
