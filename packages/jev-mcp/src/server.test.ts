import { describe, it, expect, afterEach, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { JevClient } from '@dsh-jev/core';
import { buildServer } from './server.js';

/** JSON body captured by a fake fetch. */
type Captured = { url: string; init: RequestInit };

const ok = (answer: unknown) => new Response(JSON.stringify({ answer }), { status: 200 });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

interface Harness {
  client: Client;
  calls: Captured[];
}

/** Wire buildServer to a real MCP Client over an in-memory transport. */
async function start(fetchImpl: typeof fetch): Promise<Harness> {
  const calls: Captured[] = [];
  const wrapped: typeof fetch = (async (input, init) => {
    calls.push({ url: String(input), init: init as RequestInit });
    return fetchImpl(input as RequestInfo, init as RequestInit);
  }) as typeof fetch;
  const server = buildServer(new JevClient({ apiKey: 'test-key', endpoint: 'https://jev.test/api', timeoutMs: 200, fetchImpl: wrapped }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return { client, calls };
}

const textOf = (r: { content: Array<{ type: string; text?: string }> }) => r.content[0].text ?? '';

const payloadAfter = (text: string) => JSON.parse(text.split('\n').slice(1).join('\n'));

describe('tool listing', () => {
  it('exposes exactly jev_choice / jev_score / jev_noul', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(ok({ text: 'x' })));
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['jev_choice', 'jev_noul', 'jev_score']);
  });
});

describe('jev_choice', () => {
  it('returns the remote pick with jev: ok on success', async () => {
    const { client, calls } = await start(vi.fn().mockResolvedValue(ok({ pickedIndex: 1, rationale: 'b is safer' })));
    const res = await client.callTool({ name: 'jev_choice', arguments: { question: 'pick one', options: ['a', 'b', 'c'] } });
    const text = textOf(res as never);
    expect(text).toContain('jev: ok');
    expect(payloadAfter(text)).toEqual({ pickedIndex: 1, picked: 'b', rationale: 'b is safer' });
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toMatchObject({ primitive: 'choice', question: 'pick one', options: ['a', 'b', 'c'] });
  });

  it('degrades to the default fallback (first option) on missing JEV_API_KEY auth failure', async () => {
    // No api key configured -> server 401 -> degrade to first option.
    const server = buildServer(new JevClient({ endpoint: 'https://jev.test/api', fetchImpl: vi.fn().mockResolvedValue(new Response('no auth', { status: 401 })) }));
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: 't', version: '0' });
    await client.connect(ct);
    const res = await client.callTool({ name: 'jev_choice', arguments: { question: 'q', options: ['x', 'y'] } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded (HTTP 401)');
    expect(payloadAfter(text)).toEqual({ pickedIndex: 0, picked: 'x' });
    expect((res as { isError?: boolean }).isError).toBeFalsy();
  });

  it('degrades to fallbackPick when provided and the call times out', async () => {
    const { client } = await start(vi.fn((_u: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_res, rej) => {
      (init?.signal as AbortSignal)?.addEventListener('abort', () => rej(new Error('This operation was aborted')));
    })));
    const res = await client.callTool({ name: 'jev_choice', arguments: { question: 'q', options: ['a', 'b'], fallbackPick: 'b' } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded');
    expect(payloadAfter(text)).toEqual({ pickedIndex: 1, picked: 'b' });
  });

  it('rejects fallbackPick when it is not one of options', async () => {
    const { client, calls } = await start(vi.fn().mockResolvedValue(ok({ pickedIndex: 0 })));
    const res = await client.callTool({
      name: 'jev_choice',
      arguments: { question: 'q', options: ['a', 'b'], fallbackPick: 'missing' },
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res as never)).toContain('fallbackPick must match one of options');
    expect(calls).toHaveLength(0);
  });

  it('degrades on malformed response payloads', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(new Response('<html>not json</html>', { status: 200 })));
    const res = await client.callTool({ name: 'jev_choice', arguments: { question: 'q', options: ['a'] } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded (malformed JSON response)');
    expect(payloadAfter(text)).toEqual({ pickedIndex: 0, picked: 'a' });
  });
});

describe('jev_score', () => {
  it('returns remote scores on success', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(ok({ scores: [0.9, 0.1], rationale: 'r' })));
    const res = await client.callTool({ name: 'jev_score', arguments: { subject: 's', criteria: ['c1', 'c2'] } });
    const text = textOf(res as never);
    expect(text).toContain('jev: ok');
    expect(payloadAfter(text)).toEqual({ scores: [0.9, 0.1], rationale: 'r' });
  });

  it('degrades to neutral 0.5 scores per criterion on 5xx', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(new Response('boom', { status: 503 })));
    const res = await client.callTool({ name: 'jev_score', arguments: { subject: 's', criteria: ['a', 'b', 'c'] } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded (HTTP 503)');
    expect(payloadAfter(text)).toEqual({ scores: [0.5, 0.5, 0.5] });
  });

  it('degrades to a custom fallbackScore on shape mismatch', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(ok({ scores: [1] })));
    const res = await client.callTool({ name: 'jev_score', arguments: { subject: 's', criteria: ['a', 'b'], fallbackScore: 0.25 } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded');
    expect(payloadAfter(text)).toEqual({ scores: [0.25, 0.25] });
  });
});

describe('jev_noul', () => {
  it('returns remote text on success', async () => {
    const { client } = await start(vi.fn().mockResolvedValue(ok({ text: 'noul says hi' })));
    const res = await client.callTool({ name: 'jev_noul', arguments: { prompt: 'reflect' } });
    const text = textOf(res as never);
    expect(text).toContain('jev: ok');
    expect(payloadAfter(text)).toEqual({ text: 'noul says hi' });
  });

  it('degrades to caller fallbackText on timeout', async () => {
    const { client } = await start(vi.fn((_u: unknown, init?: RequestInit): Promise<Response> => new Promise<Response>((_res, rej) => {
      (init?.signal as AbortSignal)?.addEventListener('abort', () => rej(new Error('This operation was aborted')));
    })));
    const res = await client.callTool({ name: 'jev_noul', arguments: { prompt: 'p', fallbackText: 'offline note' } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded');
    expect(payloadAfter(text)).toEqual({ text: 'offline note' });
  });

  it('degrades to empty text on network error', async () => {
    const { client } = await start(vi.fn().mockRejectedValue(new TypeError('fetch failed')));
    const res = await client.callTool({ name: 'jev_noul', arguments: { prompt: 'p' } });
    const text = textOf(res as never);
    expect(text).toContain('jev: degraded (fetch failed)');
    expect(payloadAfter(text)).toEqual({ text: '' });
  });
});
