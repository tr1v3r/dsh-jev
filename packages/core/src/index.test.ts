import { describe, it, expect, vi, afterEach } from 'vitest';
import { JevClient, JEV_DEFAULT_ENDPOINT } from './index.js';

const ok = (answer: unknown) =>
  new Response(JSON.stringify({ answer }), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('JevClient.choice', () => {
  it('resolves with the remote answer on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ pickedIndex: 1, rationale: 'b is safer' }));
    const c = new JevClient({ apiKey: 'k', fetchImpl });
    const out = await c.choice(
      { question: 'pick', options: ['a', 'b'] },
      { pickedIndex: 0, picked: 'a' }
    );
    expect(out.ok).toBe(true);
    expect(out.value).toEqual({ pickedIndex: 1, picked: 'b', rationale: 'b is safer' });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(JEV_DEFAULT_ENDPOINT);
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer k');
    expect(JSON.parse(init.body as string)).toEqual({
      primitive: 'choice',
      question: 'pick',
      options: ['a', 'b'],
    });
  });

  it('degrades to fallback without throwing on HTTP 500', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response('boom', { status: 500 }));
    const c = new JevClient({ fetchImpl });
    const out = await c.choice({ question: 'q', options: ['x'] }, { pickedIndex: 0, picked: 'x' });
    expect(out.ok).toBe(false);
    expect(out.value.picked).toBe('x');
    expect(out.error).toBe('HTTP 500');
  });

  it('degrades when pickedIndex is out of range (malformed answer)', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ pickedIndex: 9 }));
    const c = new JevClient({ fetchImpl });
    const out = await c.choice({ question: 'q', options: ['x', 'y'] }, { pickedIndex: 0, picked: 'x' });
    expect(out.ok).toBe(false);
    expect(out.value.picked).toBe('x');
  });

  it.each([null, false, '', [], true, '1', [1]])(
    'degrades when pickedIndex has non-number value %j',
    async (pickedIndex) => {
      const c = new JevClient({ fetchImpl: vi.fn().mockResolvedValue(ok({ pickedIndex })) });
      const fallback = { pickedIndex: 0, picked: 'x' };
      const out = await c.choice({ question: 'q', options: ['x', 'y'] }, fallback);
      expect(out.ok).toBe(false);
      expect(out.value).toEqual(fallback);
      expect(out.error).toContain('invalid pickedIndex');
    }
  );
});

describe('JevClient.score', () => {
  it('returns per-criterion scores on success', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ scores: [0.9, 0.4] }));
    const c = new JevClient({ fetchImpl });
    const out = await c.score(
      { subject: 'plan', criteria: ['cost', 'risk'] },
      { scores: [0.5, 0.5] }
    );
    expect(out.ok).toBe(true);
    expect(out.value.scores).toEqual([0.9, 0.4]);
  });

  it('degrades on wrong arity of scores', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ scores: [1] }));
    const c = new JevClient({ fetchImpl });
    const out = await c.score(
      { subject: 'plan', criteria: ['cost', 'risk'] },
      { scores: [0.5, 0.5] }
    );
    expect(out.ok).toBe(false);
    expect(out.value.scores).toEqual([0.5, 0.5]);
  });

  it.each([
    [null, true],
    ['0.2', 0.8],
    [[], 0.8],
    [[0.2], 0.8],
    [2, -1],
    [Number.NaN, 0.8],
    [Number.POSITIVE_INFINITY, 0.8],
  ])('degrades on invalid score values %j', async (...scores) => {
    const fallback = { scores: [0.5, 0.5] };
    const c = new JevClient({ fetchImpl: vi.fn().mockResolvedValue(ok({ scores })) });
    const out = await c.score({ subject: 'plan', criteria: ['cost', 'risk'] }, fallback);
    expect(out.ok).toBe(false);
    expect(out.value).toEqual(fallback);
    expect(out.error).toContain('invalid score');
  });
});

describe('JevClient.noul', () => {
  it('returns text on success and degrades on missing text', async () => {
    const good = new JevClient({ fetchImpl: vi.fn().mockResolvedValue(ok({ text: 'reflect…' })) });
    expect((await good.noul({ prompt: 'p' }, { text: 'fb' })).value.text).toBe('reflect…');

    const bad = new JevClient({ fetchImpl: vi.fn().mockResolvedValue(ok({})) });
    const out = await bad.noul({ prompt: 'p' }, { text: 'fb' });
    expect(out.ok).toBe(false);
    expect(out.value.text).toBe('fb');
  });
});

describe('failure modes never throw', () => {
  const fallback = { pickedIndex: 0, picked: 'x' };
  it.each([
    ['network reject', () => Promise.reject(new Error('ECONNREFUSED'))],
    ['timeout abort', () => Promise.reject(new DOMException('signal timed out', 'TimeoutError'))],
    ['non-json body', () => Promise.resolve(new Response('<html>', { status: 200 }))],
  ])('%s degrades to fallback', async (_name, fetchResult) => {
    const c = new JevClient({ fetchImpl: () => fetchResult() as Promise<Response> });
    const out = await c.choice({ question: 'q', options: ['x'] }, fallback);
    expect(out.ok).toBe(false);
    expect(out.value).toEqual(fallback);
    expect(typeof out.error).toBe('string');
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe('configuration', () => {
  it('reads JEV_API_KEY from env when not provided', async () => {
    vi.stubEnv('JEV_API_KEY', 'env-key');
    const fetchImpl = vi.fn().mockResolvedValue(ok({ pickedIndex: 0 }));
    const c = new JevClient({ fetchImpl });
    await c.choice({ question: 'q', options: ['x'] }, { pickedIndex: 0, picked: 'x' });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer env-key');
  });

  it('honors custom endpoint and strips trailing slashes', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(ok({ pickedIndex: 0 }));
    const c = new JevClient({ endpoint: 'http://localhost:9/v1/systemone///', fetchImpl });
    await c.choice({ question: 'q', options: ['x'] }, { pickedIndex: 0, picked: 'x' });
    expect(fetchImpl.mock.calls[0][0]).toBe('http://localhost:9/v1/systemone');
  });
});
