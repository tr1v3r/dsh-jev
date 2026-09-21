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

function makeHarness(llm: any = { listProviders: () => [{ id: 'deepseek-official' }, { id: 'zai-coding-cn' }] }): Harness {
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
  const llm = { listProviders: () => [{ id: 'deepseek-official' }, { id: 'zai-coding-cn' }] };

  it('light pick maps to the light route', () => {
    const r = selectRoute(okOutcome('light'), resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(false);
    expect(r.route).toEqual({ provider: 'zai-coding-cn', model: 'glm-5.3-flash' });
  });

  it('heavy pick keeps the heavy route when already there', () => {
    const r = selectRoute(okOutcome('heavy'), resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(true); // already on heavy
  });

  it('degraded outcome keeps the default route', () => {
    const r = selectRoute(degraded, resolvedConfig as any, {}, llm);
    expect(r.keepDefault).toBe(true);
    expect(r.reason).toContain('degraded');
  });

  it('unregistered target provider keeps the default route', () => {
    const emptyLlm = { listProviders: () => [{ id: 'deepseek-official' }] };
    const r = selectRoute(okOutcome('light'), resolvedConfig as any, {}, emptyLlm);
    expect(r.keepDefault).toBe(true);
    expect(r.reason).toContain('not registered');
  });

  it('throwing listProviders is treated as unregistered', () => {
    const badLlm = { listProviders: () => { throw new Error('boom'); } };
    expect(selectRoute(okOutcome('light'), resolvedConfig as any, {}, badLlm).keepDefault).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// plugin wiring
// ---------------------------------------------------------------------------

describe('apply', () => {
  it('keeps default routing logs off stdout used by the TUI renderer', async () => {
    const { fetchImpl } = mockJevFetch('light');
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const h = makeHarness();
      apply(h.ctx, { fetchImpl });
      await runRequest(h);
      expect(stdout).not.toHaveBeenCalled();
      expect(stderr).toHaveBeenCalledWith(expect.stringContaining('[dsh-jev-router]'));
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

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
