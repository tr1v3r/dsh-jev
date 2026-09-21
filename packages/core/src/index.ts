/**
 * @dsh-jev/core — jev System One client.
 *
 * Contract: every public call RESOLVES and never rejects. On any failure
 * (network error, timeout, non-2xx, malformed response) the call degrades to
 * the caller-supplied fallback and reports `degraded: true` plus an `error`
 * reason. Callers must be able to rely on `value` always being present.
 */

export const JEV_DEFAULT_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
export const JEV_DEFAULT_TIMEOUT_MS = 4_000;

export type JevPrimitive = 'choice' | 'score' | 'noul';

/** Envelope returned by every public method. */
export interface JevOutcome<T> {
  /** true when the remote call succeeded, false when a fallback was used. */
  ok: boolean;
  /** The usable value — remote answer on success, fallback otherwise. */
  value: T;
  /** Human-readable failure reason when ok === false. */
  error?: string;
  /** Milliseconds the call took. */
  durationMs: number;
}

export interface JevClientOptions {
  /** Bearer token; read from JEV_API_KEY when omitted. */
  apiKey?: string;
  endpoint?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
}

export interface ChoiceRequest {
  question: string;
  options: string[];
  /** Optional free-form context forwarded to System One. */
  context?: Record<string, unknown>;
  /** Optional caller cancellation, combined with the client's timeout. */
  signal?: AbortSignal;
}

export interface ScoreRequest {
  subject: string;
  criteria: string[];
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface NoulRequest {
  prompt: string;
  context?: Record<string, unknown>;
  signal?: AbortSignal;
}

export interface ChoiceAnswer {
  pickedIndex: number;
  picked: string;
  rationale?: string;
}

export interface ScoreAnswer {
  /** One score per criterion, in order, each in [0, 1]. */
  scores: number[];
  rationale?: string;
}

export interface NoulAnswer {
  text: string;
}

function envApiKey(): string | undefined {
  return typeof process !== 'undefined' ? process.env?.JEV_API_KEY : undefined;
}

export class JevClient {
  private readonly endpoint: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: JevClientOptions = {}) {
    this.endpoint = (opts.endpoint ?? JEV_DEFAULT_ENDPOINT).replace(/\/+$/, '');
    this.apiKey = opts.apiKey ?? envApiKey();
    this.timeoutMs = opts.timeoutMs ?? JEV_DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Pick one option; falls back to `fallback.pickedIndex`. */
  async choice(req: ChoiceRequest, fallback: ChoiceAnswer): Promise<JevOutcome<ChoiceAnswer>> {
    const { signal, ...body } = req;
    return this.call<ChoiceAnswer>('choice', body, fallback, (raw) => {
      const r = raw as Record<string, unknown> | undefined;
      const idx = r?.pickedIndex;
      if (typeof idx !== 'number' || !Number.isInteger(idx) || idx < 0 || idx >= req.options.length) {
        throw new Error(`invalid pickedIndex: ${JSON.stringify(idx)}`);
      }
      return { pickedIndex: idx, picked: req.options[idx], rationale: r?.rationale as string | undefined };
    }, signal);
  }

  /** Score a subject against criteria; falls back to `fallback.scores`. */
  async score(req: ScoreRequest, fallback: ScoreAnswer): Promise<JevOutcome<ScoreAnswer>> {
    const { signal, ...body } = req;
    return this.call<ScoreAnswer>('score', body, fallback, (raw) => {
      const r = raw as Record<string, unknown> | undefined;
      const arr = Array.isArray(r?.scores) ? (r!.scores as unknown[]) : [];
      if (arr.length !== req.criteria.length) {
        throw new Error(`expected ${req.criteria.length} scores, got ${arr.length}`);
      }
      if (arr.some((s) => typeof s !== 'number' || !Number.isFinite(s) || s < 0 || s > 1)) {
        throw new Error('invalid score in response: expected finite numbers in [0, 1]');
      }
      return { scores: arr as number[], rationale: r?.rationale as string | undefined };
    }, signal);
  }

  /** Open "noul" (no-output unconstrained) reflection; falls back to `fallback.text`. */
  async noul(req: NoulRequest, fallback: NoulAnswer): Promise<JevOutcome<NoulAnswer>> {
    const { signal, ...body } = req;
    return this.call<NoulAnswer>('noul', body, fallback, (raw) => {
      const r = raw as Record<string, unknown> | undefined;
      if (typeof r?.text !== 'string' || r.text.length === 0) {
        throw new Error('missing text in response');
      }
      return { text: r.text, rationale: r.rationale as string | undefined };
    }, signal);
  }

  private async call<T>(
    primitive: JevPrimitive,
    body: object,
    fallback: T,
    parse: (raw: unknown) => T,
    signal?: AbortSignal
  ): Promise<JevOutcome<T>> {
    const started = Date.now();
    const fail = (error: string): JevOutcome<T> => ({
      ok: false,
      value: fallback,
      error,
      durationMs: Date.now() - started,
    });
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json',
      };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ primitive, ...body }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(this.timeoutMs)])
          : AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        return fail(`HTTP ${res.status}`);
      }
      const json: unknown = await res.json().catch(() => null);
      if (json === null || typeof json !== 'object') {
        return fail('malformed JSON response');
      }
      const raw = (json as Record<string, unknown>).answer;
      const value = parse(raw);
      return { ok: true, value, durationMs: Date.now() - started };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return fail(reason);
    }
  }
}

/** Convenience: create a shared default client. */
export function createJevClient(opts: JevClientOptions = {}): JevClient {
  return new JevClient(opts);
}
