/**
 * @dsh-jev/router — per-turn jev routing for DeepSeek Harness (dsh).
 *
 * RED LINE (do not cross): this plugin NEVER registers, patches, or removes
 * LLM routes. Route registration is owned by dsh-llm-deepseek / dsh-llm-pi-ai
 * / dsh-auth, and cross-plugin registration conflicts are a known footgun
 * (see ~/.config/dsh/AGENTS.md). We only *choose* between routes that are
 * already registered in `ctx.llm` — via the `agent/request` waterfall — and
 * only when `mode: enforce` is explicitly configured. The default is
 * `shadow`: decisions are logged to stdout and the request is untouched.
 *
 * Failure semantics: any jev failure (network, timeout, non-2xx, malformed)
 * degrades to "no opinion" — the resolved config is returned unchanged, so
 * the agent keeps whatever default route it would have used.
 */

import { createJevClient, JevClient, JevOutcome, ChoiceAnswer } from '@dsh-jev/core';

export interface RouteSelection {
  provider: string;
  model: string;
  reasoningEffort?: string;
}

export interface RouterConfig {
  /** `shadow` (default) logs decisions without switching; `enforce` actually switches. */
  mode?: 'shadow' | 'enforce';
  /** Route for complex turns. */
  heavy?: RouteSelection;
  /** Route for simple turns. */
  light?: RouteSelection;
  endpoint?: string;
  apiKey?: string;
  timeoutMs?: number;
  /** Injectable fetch for tests. */
  fetchImpl?: typeof fetch;
  /** Injectable logger for tests. */
  log?: (line: string) => void;
}

export const DEFAULT_HEAVY: RouteSelection = {
  provider: 'deepseek-official',
  model: 'deepseek-flash',
};

export const DEFAULT_LIGHT: RouteSelection = {
  provider: 'zai-coding-cn',
  model: 'glm-5.3-flash',
};

// ---------------------------------------------------------------------------
// Structural types for the host surfaces we touch. Kept local and loose so
// this package has zero build-time dependencies on @deepseek-ai/* internals.
// ---------------------------------------------------------------------------

interface TextBlock {
  type: 'text';
  text: string;
}

interface UserMessage {
  content?: Array<TextBlock | { type: string; [k: string]: unknown }>;
}

/** The `agent/pre-step` payload slice we consume. */
interface PreStepPayload {
  agent: unknown;
  messages: UserMessage[];
  turn: number;
  step: number;
  signal: AbortSignal;
}

/** The `agent/request` payload slice we consume. */
interface RequestPayload {
  agent: unknown;
  turn: number;
  step: number;
  signal: AbortSignal;
}

/** Frozen LlmCallConfig slice returned by the `agent/request` waterfall. */
interface CallConfig {
  provider: string;
  model: string;
  reasoningEffort?: string;
  maxTokens?: number;
  [k: string]: unknown;
}

/** Minimal `ctx.llm` surface (read-only; we never mutate registrations). */
interface ModelInfo {
  provider: string;
  id: string;
  reasoning?: { efforts: ReadonlyArray<{ id: string }> };
}

interface LlmRegistry {
  listProviders(): Array<{ id: string; name?: string }>;
  resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<ModelInfo>;
}

interface PluginContext {
  on(event: 'agent/pre-step', listener: (payload: PreStepPayload, next: () => Promise<unknown>) => Promise<unknown>): unknown;
  on(event: 'agent/request', listener: (payload: RequestPayload, next: () => Promise<CallConfig>) => Promise<CallConfig>): unknown;
  llm?: LlmRegistry;
}

export const name = 'dsh-jev-router';
export const inject = ['llm'];

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested directly).
// ---------------------------------------------------------------------------

/** Concatenate the text blocks of the newest user message for jev context. */
export function extractUserText(messages: UserMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i]?.content;
    if (!Array.isArray(blocks) || blocks.length === 0) continue;
    const text = blocks
      .filter((b): b is TextBlock => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text.slice(0, 4000);
  }
  return '';
}

export function sameRoute(a: { provider: string; model: string }, b: { provider: string; model: string }): boolean {
  return a.provider === b.provider && a.model === b.model;
}

async function validateRoute(
  llm: LlmRegistry | undefined,
  route: RouteSelection,
  signal?: AbortSignal
): Promise<string | undefined> {
  if (!llm) return `target route ${route.provider}/${route.model} unavailable — keeping default`;
  try {
    const info = await llm.resolveModelInfo(route.provider, route.model, signal);
    if (info.provider !== route.provider || info.id !== route.model) {
      return `target route ${route.provider}/${route.model} did not resolve exactly — keeping default`;
    }
    if (route.reasoningEffort !== undefined && !info.reasoning?.efforts.some((effort) => effort.id === route.reasoningEffort)) {
      return `target effort ${route.reasoningEffort} unsupported by ${route.provider}/${route.model} — keeping default`;
    }
    return undefined;
  } catch {
    return `target route ${route.provider}/${route.model} unavailable — keeping default`;
  }
}

/** Map a jev choice outcome to a validated target route, or keep default. */
export async function selectRoute(
  outcome: JevOutcome<ChoiceAnswer>,
  resolved: CallConfig,
  config: RouterConfig,
  llm: LlmRegistry | undefined,
  signal?: AbortSignal
): Promise<{ route: RouteSelection; keepDefault: boolean; reason: string }> {
  const heavy = { ...DEFAULT_HEAVY, ...config.heavy };
  const light = { ...DEFAULT_LIGHT, ...config.light };
  if (!outcome.ok) {
    return { route: heavy, keepDefault: true, reason: `jev degraded (${outcome.error ?? 'unknown'}) — keeping default route` };
  }
  const picked = outcome.value.picked;
  const route = picked === 'light' ? light : picked === 'heavy' ? heavy : heavy;
  if (sameRoute(route, resolved)) {
    return { route, keepDefault: true, reason: `already on ${route.provider}/${route.model}` };
  }
  const invalidReason = await validateRoute(llm, route, signal);
  if (invalidReason) return { route, keepDefault: true, reason: invalidReason };
  return { route, keepDefault: false, reason: 'ok' };
}

// ---------------------------------------------------------------------------
// Plugin entry.
// ---------------------------------------------------------------------------

export function apply(ctx: PluginContext, config: RouterConfig = {}) {
  const mode = config.mode ?? 'shadow';
  const log = config.log ?? ((line: string) => process.stdout.write(line + '\n'));
  const jev: JevClient = createJevClient({
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });

  /** Per-agent turn state is bounded and expires, while retaining outcomes for retries. */
  const turnText = new WeakMap<object, Map<number, string>>();
  const decisions = new WeakMap<object, Map<number, { promise: Promise<JevOutcome<ChoiceAnswer>>; expiresAt: number }>>();
  const MAX_TURNS = 32;
  const TURN_TTL_MS = 60_000;

  const prune = (agent: object, now = Date.now()) => {
    const perTurn = decisions.get(agent);
    if (!perTurn) return;
    for (const [turn, entry] of perTurn) {
      if (entry.expiresAt <= now) {
        perTurn.delete(turn);
        turnText.get(agent)?.delete(turn);
      }
    }
    while (perTurn.size > MAX_TURNS) {
      const oldest = perTurn.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      perTurn.delete(oldest);
      turnText.get(agent)?.delete(oldest);
    }
  };

  const evaluate = async (agent: unknown, turn: number, signal: AbortSignal): Promise<JevOutcome<ChoiceAnswer>> => {
    const key = agent as object;
    prune(key);
    const perTurn = decisions.get(key) ?? new Map<number, { promise: Promise<JevOutcome<ChoiceAnswer>>; expiresAt: number }>();
    decisions.set(key, perTurn);
    const existing = perTurn.get(turn);
    if (existing) return existing.promise;
    const text = turnText.get(key)?.get(turn) ?? '';
    const question =
      'Classify the complexity of this assistant turn for model routing. ' +
      'Choose "heavy" when it needs strong reasoning (multi-step coding, debugging, architecture, long-context analysis). ' +
      'Choose "light" when a fast, cheap model suffices (simple Q&A, formatting, small lookups, chit-chat).';
    const promise = jev.choice(
      { question, options: ['heavy', 'light'], context: text ? { userTurn: text } : {}, signal },
      { pickedIndex: 0, picked: 'heavy' } // structural fallback; degraded outcomes keep the default route anyway
    );
    perTurn.set(turn, { promise, expiresAt: Date.now() + TURN_TTL_MS });
    prune(key);
    return promise;
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const perTurn = turnText.get(payload.agent as object) ?? new Map<number, string>();
    perTurn.set(payload.turn, extractUserText(payload.messages));
    turnText.set(payload.agent as object, perTurn);
    return decision;
  });

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    let outcome: JevOutcome<ChoiceAnswer>;
    try {
      outcome = await evaluate(payload.agent, payload.turn, payload.signal);
    } catch {
      // JevClient contractually never throws, but stay defensive: keep default.
      return resolved;
    }
    const { route, keepDefault, reason } = await selectRoute(outcome, resolved, config, ctx.llm, payload.signal);
    const label = `turn=${payload.turn} step=${payload.step} picked=${outcome.value.picked}` +
      (outcome.ok ? '' : ` (degraded)`) +
      ` target=${route.provider}/${route.model}` +
      ` from=${resolved.provider}/${resolved.model}`;
    if (keepDefault) {
      log(`[dsh-jev-router] ${label} keep-default — ${reason}`);
      return resolved;
    }
    if (mode !== 'enforce') {
      log(`[dsh-jev-router] ${label} shadow (set mode: enforce to switch)`);
      return resolved;
    }
    log(`[dsh-jev-router] ${label} enforcing switch`);
    return {
      ...resolved,
      provider: route.provider,
      model: route.model,
      ...(route.reasoningEffort !== undefined ? { reasoningEffort: route.reasoningEffort } : {}),
    };
  });
}
