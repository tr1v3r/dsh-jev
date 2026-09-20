/**
 * dsh-jev-effort — host face.
 *
 * Web-only feature (the bundle patch is only inserted into the Web profile),
 * but this host entry is the half that can actually see the request: on the
 * `agent/request` waterfall it asks jev System One whether the current turn
 * is simple enough to lower `reasoningEffort` to `low`. It NEVER touches
 * provider/model — route selection belongs elsewhere (dsh-jev-router does
 * that job deliberately, with its own gates) — and on any jev failure it
 * silently returns the resolved config unchanged (original effort kept).
 *
 * The browser half (lib/client.js) renders the dismissible composer hint.
 */

import { createJevClient } from '@dsh-jev/core';

/** Rank: lower number = more effort. Unknown efforts never get lowered. */
export const EFFORT_RANK = { max: 0, high: 1, medium: 2, low: 3 };

export function canLowerEffort(current, target = 'low') {
  const a = EFFORT_RANK[current];
  const b = EFFORT_RANK[target];
  if (a === undefined || b === undefined) return false;
  return b > a;
}

/** Pure decision used by the request listener (unit-tested directly). */
export function decideEffort(
  outcome /* JevOutcome<ChoiceAnswer> */,
  resolved /* frozen LlmCallConfig */,
  target = 'low'
) {
  if (!outcome.ok) {
    return { effort: resolved.reasoningEffort, lowered: false, reason: `jev degraded (${outcome.error ?? 'unknown'}) — keeping effort` };
  }
  if (outcome.value.picked !== 'lower') {
    return { effort: resolved.reasoningEffort, lowered: false, reason: 'jev says keep' };
  }
  if (!canLowerEffort(resolved.reasoningEffort, target)) {
    return { effort: resolved.reasoningEffort, lowered: false, reason: `effort ${String(resolved.reasoningEffort)} not lowerable to ${target}` };
  }
  return { effort: target, lowered: true, reason: 'ok' };
}

export const name = 'jev-effort';
export const inject = [];

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

  /** Newest user text per agent per turn, captured at pre-step. */
  const turnText = new WeakMap();

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
    try {
      const text = turnText.get(payload.agent)?.get(payload.turn) ?? '';
      outcome = await jev.choice(
        {
          question:
            'Should this assistant turn run with reduced reasoning effort? ' +
            'Answer "lower" only for simple turns (short factual Q&A, formatting, chit-chat) ' +
            'where deep reasoning adds latency without value. Otherwise answer "keep".',
          options: ['keep', 'lower'],
          context: text ? { userTurn: text } : {},
        },
        { pickedIndex: 0, picked: 'keep' } // degraded outcomes keep the original effort
      );
    } catch {
      return resolved; // defensive: JevClient never throws, but never break a request
    }
    const { effort, lowered, reason } = decideEffort(outcome, resolved, target);
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
