import { describe, expect, it } from 'vitest';
import { apply, canLowerEffort, decideEffort, latestUserText } from '../lib/index.js';

function mockJevFetch(picked) {
  return async (_url, init) => {
    if (picked === 'DEGRADE') return new Response('nope', { status: 500 });
    return Response.json({ answer: { pickedIndex: picked === 'lower' ? 1 : 0, picked } });
  };
}

function makeHarness() {
  const listeners = new Map();
  return {
    listeners,
    ctx: { on: (event, listener) => listeners.set(event, listener) },
  };
}

async function runRequest(h, { turn = 1, resolved, config = {} } = {}) {
  const agent = {};
  await h.listeners.get('agent/pre-step')(
    { agent, turn, step: 1, messages: [{ content: [{ type: 'text', text: 'hi' }] }], signal: new AbortController().signal },
    async () => ({ kind: 'enter', messages: [] })
  );
  return h.listeners.get('agent/request')(
    { agent, turn, step: 1, signal: new AbortController().signal },
    async () => resolved
  );
}

const base = { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high' };

describe('canLowerEffort', () => {
  it('allows max/high/medium → low', () => {
    expect(canLowerEffort('max')).toBe(true);
    expect(canLowerEffort('high')).toBe(true);
    expect(canLowerEffort('medium')).toBe(true);
  });
  it('refuses low/undefined/unknown', () => {
    expect(canLowerEffort('low')).toBe(false);
    expect(canLowerEffort(undefined)).toBe(false);
    expect(canLowerEffort('warp')).toBe(false);
  });
});

describe('decideEffort', () => {
  const ok = (picked) => ({ ok: true, value: { pickedIndex: picked === 'lower' ? 1 : 0, picked } });
  const degraded = { ok: false, value: { pickedIndex: 0, picked: 'keep' }, error: 'HTTP 500' };

  it('lowers on a "lower" pick', () => {
    expect(decideEffort(ok('lower'), base)).toEqual({ effort: 'low', lowered: true, reason: 'ok' });
  });
  it('keeps on a "keep" pick', () => {
    expect(decideEffort(ok('keep'), base).lowered).toBe(false);
  });
  it('keeps silently when jev degraded', () => {
    const r = decideEffort(degraded, base);
    expect(r.lowered).toBe(false);
    expect(r.effort).toBe('high');
    expect(r.reason).toContain('degraded');
  });
  it('never touches already-low or unknown efforts', () => {
    expect(decideEffort(ok('lower'), { ...base, reasoningEffort: 'low' }).lowered).toBe(false);
    expect(decideEffort(ok('lower'), { provider: 'x', model: 'y' }).lowered).toBe(false);
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

  it('custom target effort is honored', async () => {
    const h = makeHarness();
    apply(h.ctx, { fetchImpl: mockJevFetch('lower'), log: () => {}, targetEffort: 'medium' });
    const out = await runRequest(h, { resolved: { ...base, reasoningEffort: 'max' } });
    expect(out.reasoningEffort).toBe('medium');
  });
});
