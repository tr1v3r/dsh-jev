import { describe, expect, it } from 'vitest';
import { apply, canLowerEffort, decideEffort, latestUserText } from '../lib/index.js';

function mockJevFetch(picked: string) {
  return async (_url: string, init?: RequestInit): Promise<Response> => {
    if (picked === 'DEGRADE') return new Response('nope', { status: 500 });
    return Response.json({ answer: { pickedIndex: picked === 'lower' ? 1 : 0, picked } });
  };
}

function makeHarness(model: any = {
  provider: 'deepseek-official',
  id: 'deepseek-flash',
  reasoning: { efforts: [{ id: 'low' }, { id: 'high' }, { id: 'max' }] },
}) {
  const listeners = new Map<string, (...args: any[]) => any>();
  return {
    listeners,
    ctx: {
      llm: { resolveModelInfo: async () => model },
      on: (event: string, listener: (...args: any[]) => any) => listeners.set(event, listener),
    },
  };
}

type ResolvedConfig = { provider: string; model: string; reasoningEffort?: string };

async function runRequest(
  h: ReturnType<typeof makeHarness>,
  opts: { turn?: number; resolved?: ResolvedConfig; config?: Record<string, unknown> } = {},
) {
  const { turn = 1, resolved } = opts;
  const agent = {};
  await h.listeners.get('agent/pre-step')!(
    { agent, turn, step: 1, messages: [{ content: [{ type: 'text', text: 'hi' }] }], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] })
  );
  return h.listeners.get('agent/request')!(
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => resolved
  );
}

const base = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };

describe('canLowerEffort', () => {
  const modelEfforts = [{ id: 'economy' }, { id: 'balanced' }, { id: 'intense' }];
  it('uses the exact model-specific effort ordering', () => {
    expect(canLowerEffort('intense', 'economy', modelEfforts)).toBe(true);
    expect(canLowerEffort('balanced', 'economy', modelEfforts)).toBe(true);
  });
  it('refuses unsupported, equal, or higher targets', () => {
    expect(canLowerEffort('economy', 'economy', modelEfforts)).toBe(false);
    expect(canLowerEffort('economy', 'intense', modelEfforts)).toBe(false);
    expect(canLowerEffort('high', 'low', modelEfforts)).toBe(false);
  });
});

describe('decideEffort', () => {
  const ok = (picked: string) => ({ ok: true, value: { pickedIndex: picked === 'lower' ? 1 : 0, picked } });
  const degraded = { ok: false, value: { pickedIndex: 0, picked: 'keep' }, error: 'HTTP 500' };

  it('lowers on a "lower" pick', () => {
    expect(decideEffort(ok('lower'), base, 'low', [{ id: 'low' }, { id: 'high' }])).toEqual({ effort: 'low', lowered: true, reason: 'ok' });
  });
  it('keeps on a "keep" pick', () => {
    expect(decideEffort(ok('keep'), base, 'low', [{ id: 'low' }, { id: 'high' }]).lowered).toBe(false);
  });
  it('keeps silently when jev degraded', () => {
    const r = decideEffort(degraded, base, 'low', [{ id: 'low' }, { id: 'high' }]);
    expect(r.lowered).toBe(false);
    expect(r.effort).toBe('high');
    expect(r.reason).toContain('degraded');
  });
  it('never touches already-low or unknown efforts', () => {
    const supported = [{ id: 'low' }, { id: 'high' }];
    expect(decideEffort(ok('lower'), { ...base, reasoningEffort: 'low' }, 'low', supported).lowered).toBe(false);
    expect(decideEffort(ok('lower'), { provider: 'x', model: 'y' }, 'low', supported).lowered).toBe(false);
  });
});

describe('latestUserText', () => {
  it('returns the newest user text, bounded', () => {
    expect(latestUserText([{ content: [{ type: 'text', text: 'a' }] }, { content: [{ type: 'text', text: 'b' }] }])).toBe('b');
    expect(latestUserText([{ content: [{ type: 'text', text: 'x'.repeat(9000) }] }]).length).toBe(4000);
    expect(latestUserText([{ content: [{ type: 'tool-result' }] }])).toBe('');
  });
});

describe('apply', () => {
  it('lowers effort end-to-end via agent/request and never touches provider/model', async () => {
    const h = makeHarness();
    apply(h.ctx, { fetchImpl: mockJevFetch('lower'), log: () => {} });
    const out = await runRequest(h, { resolved: { ...base } });
    expect(out).toEqual({ provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'low' });
  });

  it('jev failure silently keeps the original effort', async () => {
    const h = makeHarness();
    apply(h.ctx, { fetchImpl: mockJevFetch('DEGRADE'), log: () => {} });
    const out = await runRequest(h, { resolved: { ...base } });
    expect(out).toEqual(base);
  });

  it('config.enabled=false disables the plugin entirely (no jev call)', async () => {
    const h = makeHarness();
    let calls = 0;
    apply(h.ctx, {
      enabled: false,
      fetchImpl: async () => {
        calls++;
        return Response.json({});
      },
      log: () => {},
    });
    const out = await runRequest(h, { resolved: { ...base } });
    expect(out).toEqual(base);
    expect(calls).toBe(0);
  });

  it('custom model-specific target effort is honored', async () => {
    const h = makeHarness({
      provider: 'deepseek-official', id: 'deepseek-flash',
      reasoning: { efforts: [{ id: 'economy' }, { id: 'balanced' }, { id: 'intense' }] },
    });
    apply(h.ctx, { fetchImpl: mockJevFetch('lower'), log: () => {}, targetEffort: 'balanced' });
    const out = await runRequest(h, { resolved: { ...base, reasoningEffort: 'intense' } });
    expect(out.reasoningEffort).toBe('balanced');
  });

  it('keeps effort for missing models, mismatched routes, and unsupported targets', async () => {
    for (const [model, target] of [
      [null, 'low'],
      [{ provider: 'other', id: 'deepseek-flash', reasoning: { efforts: [{ id: 'low' }, { id: 'high' }] } }, 'low'],
      [{ provider: 'deepseek-official', id: 'deepseek-flash', reasoning: { efforts: [{ id: 'eco' }, { id: 'pro' }] } }, 'low'],
    ] as const) {
      const h = makeHarness(model);
      if (model === null) h.ctx.llm.resolveModelInfo = async () => { throw new Error('missing'); };
      apply(h.ctx, { fetchImpl: mockJevFetch('lower'), log: () => {}, targetEffort: target });
      expect(await runRequest(h, { resolved: { ...base } })).toEqual(base);
    }
  });

  it('propagates request cancellation and keeps the original effort', async () => {
    const h = makeHarness();
    let observed: AbortSignal | undefined;
    apply(h.ctx, {
      timeoutMs: 10_000,
      fetchImpl: async (_url: unknown, init?: RequestInit) => await new Promise<Response>((_resolve, reject) => {
        observed = init?.signal as AbortSignal;
        observed.addEventListener('abort', () => reject(observed?.reason), { once: true });
      }),
      log: () => {},
    });
    const controller = new AbortController();
    const agent = {};
    const pending = h.listeners.get('agent/request')!(
      { agent, turn: 9, step: 1, signal: controller.signal },
      async () => ({ ...base })
    );
    while (!observed) await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new Error('cancelled'));
    expect(await pending).toEqual(base);
    expect(observed.aborted).toBe(true);
  });

  it('bounds retained turn decisions and evicts the oldest entry', async () => {
    const h = makeHarness();
    let calls = 0;
    apply(h.ctx, { fetchImpl: async () => { calls++; return Response.json({ answer: { pickedIndex: 0, picked: 'keep' } }); }, log: () => {} });
    const agent = {};
    const signal = new AbortController().signal;
    const listener = h.listeners.get('agent/request')!;
    const next = async () => ({ ...base });
    for (let turn = 1; turn <= 33; turn++) await listener({ agent, turn, step: 1, signal }, next);
    await listener({ agent, turn: 1, step: 2, signal }, next);
    expect(calls).toBe(34);
  });

  it('reuses one decision for concurrent requests, later steps, and retries', async () => {
    const h = makeHarness();
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    apply(h.ctx, { fetchImpl: async () => { calls++; await gate; return Response.json({ answer: { pickedIndex: 1, picked: 'lower' } }); }, log: () => {} });
    const agent = {};
    const signal = new AbortController().signal;
    await h.listeners.get('agent/pre-step')!({ agent, turn: 4, step: 1, messages: [], signal }, async () => ({}));
    const listener = h.listeners.get('agent/request')!;
    const next = async () => ({ ...base });
    const a = listener({ agent, turn: 4, step: 1, signal }, next);
    const b = listener({ agent, turn: 4, step: 1, signal }, next);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    release();
    await Promise.all([a, b]);
    await listener({ agent, turn: 4, step: 2, signal }, next);
    await listener({ agent, turn: 4, step: 1, signal }, next);
    expect(calls).toBe(1);
  });
});
