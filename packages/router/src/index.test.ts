import { describe, expect, it, vi } from 'vitest';
import { apply, extractUserText, selectRoute, RouterConfig } from './index.js';
import { JevOutcome, ChoiceAnswer } from '@dsh-jev/core';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FetchCall = { url: string; body: any };

function mockJevFetch(picked: 'heavy' | 'light' | 'DEGRADE'): { fetchImpl: typeof fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body) });
    if (picked === 'DEGRADE') {
      return new Response('nope', { status: 403 });
    }
    return Response.json({ answer: { pickedIndex: picked === 'light' ? 1 : 0, picked, rationale: 'test' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

interface Harness {
  listeners: Map<string, (payload: any, next: () => Promise<any>) => Promise<any>>;
  ctx: any;
}

function makeHarness(llm: any = {
  listProviders: () => [{ id: 'deepseek-official' }, { id: 'zai-coding-cn' }],
  resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model }),
}): Harness {
  const listeners = new Map<string, (payload: any, next: () => Promise<any>) => Promise<any>>();
  const ctx = {
    llm,
    on: (event: string, listener: any) => listeners.set(event, listener),
  };
  return { listeners, ctx };
}

const resolvedConfig = { provider: 'deepseek-official', model: 'deepseek-flash' };

async function runRequest(h: Harness, turn = 1, next = async () => ({ ...resolvedConfig })) {
  const listener = h.listeners.get('agent/request')!;
  const agent = {};
  await h.listeners.get('agent/pre-step')!(
    { agent, turn, step: 1, messages: [], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] })
  );
  return listener({ agent, turn, step: 1, signal: new AbortController().signal }, next);
}

// ---------------------------------------------------------------------------
// extractUserText
// ---------------------------------------------------------------------------

describe('extractUserText', () => {
  it('returns the newest user message text', () => {
    const messages = [
      { content: [{ type: 'text', text: 'old question' }] },
      { content: [{ type: 'text', text: 'new question' }] },
    ];
    expect(extractUserText(messages)).toBe('new question');
  });

  it('skips messages without text blocks and truncates long input', () => {
    expect(extractUserText([{ content: [{ type: 'image', url: 'x' }] }, { content: [] }])).toBe('');
    const long = { content: [{ type: 'text', text: 'x'.repeat(9000) }] };
    expect(extractUserText([long]).length).toBe(4000);
  });
});

// ---------------------------------------------------------------------------
// selectRoute
// ---------------------------------------------------------------------------

const okOutcome = (picked: string): JevOutcome<ChoiceAnswer> => ({
  ok: true,
  value: { pickedIndex: picked === 'light' ? 1 : 0, picked },
  durationMs: 5,
});
const degraded: JevOutcome<ChoiceAnswer> = {
  ok: false,
  value: { pickedIndex: 0, picked: 'heavy' },
  error: 'HTTP 403',
  durationMs: 3,
};

describe('selectRoute', () => {
  const llm = {
    listProviders: () => [{ id: 'deepseek-official' }, { id: 'zai-coding-cn' }],
    resolveModelInfo: async (provider: string, model: string) => ({ provider, id: model }),
  };

  it('light pick maps to the light route', async () => {
    const r = await selectRoute(okOutcome('light'), resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(false);
    expect(r.route).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' });
  });

  it('heavy pick keeps the heavy route when already there', async () => {
    const r = await selectRoute(okOutcome('heavy'), resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(true); // already on heavy
  });

  it('degraded outcome keeps the default route', async () => {
    const r = await selectRoute(degraded, resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(true);
    expect(r.reason).toContain('degraded');
  });

  it('missing target model keeps the default route', async () => {
    const missing = { listProviders: () => [], resolveModelInfo: async () => { throw new Error('missing'); } };
    const r = await selectRoute(okOutcome('light'), resolvedConfig as any, {}, missing);
    expect(r.keepDefault).toBe(true);
    expect(r.reason).toContain('unavailable');
  });

  it('provider/model mismatch keeps the default route', async () => {
    const mismatch = { listProviders: () => [], resolveModelInfo: async () => ({ provider: 'other', id: 'wrong' }) };
    expect((await selectRoute(okOutcome('light'), resolvedConfig as any, {}, mismatch)).keepDefault).toBe(true);
  });

  it('unsupported target effort keeps the default route', async () => {
    const r = await selectRoute(okOutcome('light'), resolvedConfig as any, {
      light: { provider: 'zai-coding-cn', model: 'glm-5.3-flash', reasoningEffort: 'turbo' },
    }, llm);
    expect(r.keepDefault).toBe(true);
    expect(r.reason).toContain('unsupported');
  });
});

// ---------------------------------------------------------------------------
// plugin wiring
// ---------------------------------------------------------------------------

describe('apply', () => {
  it('shadow mode (default): logs but never changes config', async () => {
    const { fetchImpl } = mockJevFetch('light');
    const lines: string[] = [];
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: (l: string) => lines.push(l) });
    const out = await runRequest(h);
    expect(out).toEqual(resolvedConfig);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('shadow');
    expect(lines[0]).toContain('zai-coding-cn/glm-5.3-flash');
  });

  it('enforce mode: switches to the light route on a light pick', async () => {
    const { fetchImpl, calls } = mockJevFetch('light');
    const lines: string[] = [];
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: (l: string) => lines.push(l), mode: 'enforce' });
    const out = await runRequest(h);
    expect(out).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' });
    expect(lines[0]).toContain('enforcing switch');
    // the captured user turn reached jev as context
    expect(calls[0].body.context.userTurn ?? '').toBe('');
  });

  it('enforce mode: heavy pick from a light default switches up', async () => {
    const { fetchImpl } = mockJevFetch('heavy');
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: () => {}, mode: 'enforce' });
    const out = await runRequest(h, 1, async () => ({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' }));
    expect(out).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash' });
  });

  it('jev unreachable: keeps default and logs the degrade', async () => {
    const { fetchImpl } = mockJevFetch('DEGRADE');
    const lines: string[] = [];
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: (l: string) => lines.push(l), mode: 'enforce' });
    const out = await runRequest(h);
    expect(out).toEqual(resolvedConfig);
    expect(lines[0]).toContain('degraded');
  });

  it('pre-step captured user text is sent to jev', async () => {
    const { fetchImpl, calls } = mockJevFetch('heavy');
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: () => {} });
    const agent = {};
    await h.listeners.get('agent/pre-step')!(
      { agent, turn: 3, step: 1, messages: [{ content: [{ type: 'text', text: 'refactor the parser' }] }], signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [] })
    );
    await h.listeners.get('agent/request')!({ agent, turn: 3, step: 1, signal: new AbortController().signal }, async () => ({ ...resolvedConfig }));
    expect(calls[0].body.context.userTurn).toBe('refactor the parser');
    expect(calls[0].body.options).toEqual(['heavy', 'light']);
  });

  it('reuses one JEV decision for concurrent requests and later steps/retries', async () => {
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const fetchImpl = vi.fn(async () => {
      calls++;
      await gate;
      return Response.json({ answer: { pickedIndex: 1, picked: 'light' } });
    });
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: () => {}, mode: 'enforce' });
    const agent = {};
    await h.listeners.get('agent/pre-step')!({ agent, turn: 7, step: 1, messages: [], signal: new AbortController().signal }, async () => ({}));
    const listener = h.listeners.get('agent/request')!;
    const next = async () => ({ ...resolvedConfig });
    const first = listener({ agent, turn: 7, step: 1, signal: new AbortController().signal }, next);
    const concurrent = listener({ agent, turn: 7, step: 1, signal: new AbortController().signal }, next);
    await vi.waitFor(() => expect(calls).toBe(1));
    release();
    await Promise.all([first, concurrent]);
    await listener({ agent, turn: 7, step: 2, signal: new AbortController().signal }, next);
    await listener({ agent, turn: 7, step: 1, signal: new AbortController().signal }, next);
    expect(calls).toBe(1);
  });

  it('propagates request cancellation to the JEV fetch', async () => {
    let observed: AbortSignal | undefined;
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      observed = init?.signal as AbortSignal;
      observed.addEventListener('abort', () => reject(observed?.reason), { once: true });
    }));
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: () => {}, mode: 'enforce', timeoutMs: 10_000 });
    const controller = new AbortController();
    const agent = {};
    const pending = h.listeners.get('agent/request')!(
      { agent, turn: 8, step: 1, signal: controller.signal },
      async () => ({ ...resolvedConfig })
    );
    await vi.waitFor(() => expect(observed).toBeDefined());
    controller.abort(new Error('cancelled'));
    expect(await pending).toEqual(resolvedConfig);
    expect(observed?.aborted).toBe(true);
  });

  it('bounds retained turn decisions and evicts the oldest entry', async () => {
    const { fetchImpl, calls } = mockJevFetch('heavy');
    const h = makeHarness();
    apply(h.ctx, { fetchImpl, log: () => {} });
    const agent = {};
    const listener = h.listeners.get('agent/request')!;
    const next = async () => ({ ...resolvedConfig });
    for (let turn = 1; turn <= 33; turn++) {
      await listener({ agent, turn, step: 1, signal: new AbortController().signal }, next);
    }
    await listener({ agent, turn: 1, step: 2, signal: new AbortController().signal }, next);
    expect(calls).toHaveLength(34);
  });

  it('custom routes are honored', async () => {
    const { fetchImpl } = mockJevFetch('light');
    const h = makeHarness();
    const config: RouterConfig = {
      fetchImpl,
      log: () => {},
      mode: 'enforce',
      light: { provider: 'zai-coding-cn', model: 'glm-5.3' },
    };
    apply(h.ctx, config);
    const out = await runRequest(h);
    expect(out).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3' });
  });
});
