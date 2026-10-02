/**
 * Unit tests for the shared Pipedrive call-activity helpers:
 *   resolvePdByPhone  — phone → person + open-deal resolution
 *   pushPdCallActivity — activity body construction (incl. per-rep attribution)
 * fetch is stubbed; no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/insforge.js', () => ({
  getInsforgeClient: vi.fn(() => ({ database: { from: vi.fn(() => ({})) } })),
}));

import { resolvePdByPhone, pushPdCallActivity } from '../pipedrive.js';

const fetchMock = vi.fn();
const jsonResponse = (data: any) =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({ success: true, data }) } as any);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});

describe('resolvePdByPhone', () => {
  it('matches a person via /persons/find and logs against the most recently updated open deal', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse([{ id: 42, name: 'Jane Doe' }])) // persons/find
      .mockImplementationOnce(() => jsonResponse([
        { id: 7, title: 'Old deal', update_time: '2026-01-01T00:00:00Z' },
        { id: 9, title: 'Fresh deal', update_time: '2026-02-01T00:00:00Z' },
      ])); // deals

    const result = await resolvePdByPhone('TOKEN', '+12175550123');

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      matched: true,
      person_id: 42,
      person_name: 'Jane Doe',
      deal_id: 9,
      deal_title: 'Fresh deal',
      duplicates: [7],
    });
  });

  it('returns matched:false when no person is found', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse([])) // persons/find empty
      .mockImplementationOnce(() => jsonResponse([])); // persons fallback empty

    const result = await resolvePdByPhone('TOKEN', '+19999999999');
    expect(result).toEqual({ matched: false });
  });

  it('still matches the person when they have no open deals (deal_id null)', async () => {
    fetchMock
      .mockImplementationOnce(() => jsonResponse([{ id: 42, name: 'Jane Doe' }]))
      .mockImplementationOnce(() => jsonResponse([])); // no deals

    const result = await resolvePdByPhone('TOKEN', '+12175550123');
    expect(result).toMatchObject({ matched: true, person_id: 42, deal_id: null, duplicates: [] });
  });

  it('rejects numbers with no digits without calling the API', async () => {
    await resolvePdByPhone('TOKEN', 'client:user_abc');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to a digit comparison when /persons/find errors', async () => {
    fetchMock
      .mockImplementationOnce(() => Promise.reject(new Error('boom'))) // persons/find
      .mockImplementationOnce(() => jsonResponse([
        { id: 55, name: 'Phone Match', phone: [{ value: '+1 217 555 0123' }] },
        { id: 56, name: 'Other', phone: [{ value: '+1 999 999 9999' }] },
      ]));

    const result = await resolvePdByPhone('TOKEN', '2175550123');
    expect(result).toMatchObject({ matched: true, person_id: 55 });
  });
});

describe('pushPdCallActivity', () => {
  it('posts a done call activity with deal, note and per-rep attribution', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ id: 1001 }));

    const result = await pushPdCallActivity('TOKEN', {
      deal_id: 9,
      direction: 'outbound',
      disposition: 'answered',
      duration_secs: 125,
      notes: 'Interested in pricing',
      rep_name: 'Donavyn',
      rep_email: 'donavyn@example.com',
      pd_user_id: 777,
    });

    expect(result).toEqual({ activity_id: 1001 });
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/activities');
    const body = JSON.parse(init.body);
    expect(body.deal_id).toBe(9);
    expect(body.type).toBe('call');
    expect(body.done).toBe(1);
    expect(body.user_id).toBe(777); // rep attribution
    expect(body.note).toContain('Cold Call Machine: answered');
    expect(body.note).toContain('Duration: 2m 5s');
    expect(body.note).toContain('Notes: Interested in pricing');
    expect(body.note).toContain('Rep: Donavyn');
  });

  it('lists duplicate open deals in the note', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ id: 1002 }));

    await pushPdCallActivity('TOKEN', {
      deal_id: 9,
      duplicates: [7, 8],
      direction: 'inbound',
      disposition: 'inbound_call',
      duration_secs: 30,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.note).toContain('Other open deals: 7, 8');
    expect(body.note).toContain('(inbound)');
  });

  it('logs on the person only when there is no deal', async () => {
    fetchMock.mockImplementationOnce(() => jsonResponse({ id: 1003 }));

    await pushPdCallActivity('TOKEN', {
      person_id: 42,
      direction: 'outbound',
      disposition: 'manual_call',
      duration_secs: 0,
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.deal_id).toBeUndefined();
    expect(body.person_id).toBe(42);
    expect(body.user_id).toBeUndefined(); // no attribution passed
  });
});
