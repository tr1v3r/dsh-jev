/**
 * dsh-jev-effort — host face.
 *
 * Once per agent turn, asks jev whether the exact resolved model should use a
 * lower supported reasoning effort. Provider/model are never changed, and any
 * jev or capability lookup failure keeps the resolved config unchanged.
 */

import { createJevClient } from '@dsh-jev/core';

/** Effort IDs are opaque and ordered only by the exact model's metadata. */
export function canLowerEffort(current, target, supportedEfforts = []) {
  const ids = supportedEfforts.map((effort) => typeof effort === 'string' ? effort : effort?.id);
  const currentIndex = ids.indexOf(current);
  const targetIndex = ids.indexOf(target);
  return currentIndex >= 0 && targetIndex >= 0 && targetIndex < currentIndex;
}

/** Pure decision used by the request listener (unit-tested directly). */
export function decideEffort(
  outcome /* JevOutcome<ChoiceAnswer> */,
  resolved /* frozen LlmCallConfig */,
  target,
  supportedEfforts = []
) {
  if (!outcome.ok) {
    return { effort: resolved.reasoningEffort, lowered: false, reason: `jev degraded (${outcome.error ?? 'unknown'}) — keeping effort` };
  }
  if (outcome.value.picked !== 'lower') {
    return { effort: resolved.reasoningEffort, lowered: false, reason: 'jev says keep' };
  }
  if (!canLowerEffort(resolved.reasoningEffort, target, supportedEfforts)) {
    return { effort: resolved.reasoningEffort, lowered: false, reason: `effort ${String(resolved.reasoningEffort)} not lowerable to ${target} for this model` };
  }
  return { effort: target, lowered: true, reason: 'ok' };
}

export const name = 'jev-effort';
export const inject = ['llm'];

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false;
  const target = config.targetEffort ?? 'low';
  const log = config.log ?? (() => {});
  const jev = createJevClient({
    ...(config.endpoint !== undefined ? { endpoint: config.endpoint } : {}),
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
    ...(config.timeoutMs !== undefined ? { timeoutMs: config.timeoutMs } : {}),
    ...(config.fetchImpl !== undefined ? { fetchImpl: config.fetchImpl } : {}),
  });

  const turnText = new WeakMap();
  const decisions = new WeakMap();
  const MAX_TURNS = 32;
  const TURN_TTL_MS = 60_000;

  const prune = (agent, now = Date.now()) => {
    const perTurn = decisions.get(agent);
    if (!perTurn) return;
    for (const [turn, entry] of perTurn) {
      if (entry.expiresAt <= now) {
        perTurn.delete(turn);
        turnText.get(agent)?.delete(turn);
      }
    }
    while (perTurn.size > MAX_TURNS) {
      const oldest = perTurn.keys().next().value;
      if (oldest === undefined) break;
      perTurn.delete(oldest);
      turnText.get(agent)?.delete(oldest);
    }
  };

  const evaluate = (payload) => {
    const perTurn = decisions.get(payload.agent) ?? new Map();
    decisions.set(payload.agent, perTurn);
    prune(payload.agent);
    const existing = perTurn.get(payload.turn);
    if (existing) return existing.promise;
    const text = turnText.get(payload.agent)?.get(payload.turn) ?? '';
    const promise = jev.choice(
      {
        question:
          'Should this assistant turn run with reduced reasoning effort? ' +
          'Answer "lower" only for simple turns (short factual Q&A, formatting, chit-chat) ' +
          'where deep reasoning adds latency without value. Otherwise answer "keep".',
        options: ['keep', 'lower'],
        context: text ? { userTurn: text } : {},
        signal: payload.signal,
      },
      { pickedIndex: 0, picked: 'keep' }
    );
    perTurn.set(payload.turn, { promise, expiresAt: Date.now() + TURN_TTL_MS });
    prune(payload.agent);
    return promise;
  };

  ctx.on('agent/pre-step', async (payload, next) => {
    const decision = await next();
    const perTurn = turnText.get(payload.agent) ?? new Map();
    perTurn.set(payload.turn, latestUserText(payload.messages));
    turnText.set(payload.agent, perTurn);
    return decision;
  });

  ctx.on('agent/request', async (payload, next) => {
    const resolved = await next();
    if (!enabled) return resolved;
    let outcome;
    let model;
    try {
      [outcome, model] = await Promise.all([
        evaluate(payload),
        ctx.llm.resolveModelInfo(resolved.provider, resolved.model, payload.signal),
      ]);
    } catch {
      return resolved;
    }
    if (model.provider !== resolved.provider || model.id !== resolved.model) return resolved;
    const supported = model.reasoning?.efforts ?? [];
    const { effort, lowered, reason } = decideEffort(outcome, resolved, target, supported);
    if (lowered) {
      log(`[dsh-jev-effort] turn=${payload.turn} step=${payload.step} ${String(resolved.reasoningEffort)} → ${effort} (jev)`);
      return { ...resolved, reasoningEffort: effort };
    }
    log(`[dsh-jev-effort] turn=${payload.turn} step=${payload.step} keep (${reason})`);
    return resolved;
  });
}

/** Concatenate the newest user message's text blocks, bounded for context. */
export function latestUserText(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const blocks = messages[i]?.content;
    if (!Array.isArray(blocks)) continue;
    const text = blocks
      .filter((b) => b?.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) return text.slice(0, 4000);
  }
  return '';
}
