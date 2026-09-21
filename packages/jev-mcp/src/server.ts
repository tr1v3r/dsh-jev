/**
 * Server factory — split from the bin entry so tests can drive the tools
 * over an in-memory transport without touching stdio. No runtime behavior change.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { createRequire } from 'node:module';
import type { JevClient } from '@dsh-jev/core';

const { version } = createRequire(import.meta.url)('../package.json') as { version: string };

function report(out: { ok: boolean; value: unknown; error?: string; durationMs: number }) {
  const status = out.ok ? 'jev: ok' : `jev: degraded (${out.error})`;
  return { content: [{ type: 'text' as const, text: `${status}\n${JSON.stringify(out.value, null, 2)}` }] };
}

export function buildServer(client: Pick<JevClient, 'choice' | 'score' | 'noul'>): McpServer {
  const server = new McpServer({ name: 'dsh-jev-mcp', version });

  server.tool(
    'jev_choice',
    'Pick one option for a decision via jev System One. Degrades to fallbackPick on failure.',
    {
      question: z.string().describe('The decision question'),
      options: z.array(z.string()).min(1).describe('Candidate options'),
      fallbackPick: z.string().optional().describe('Option to use if jev is unavailable (default: first option)'),
    },
    async ({ question, options, fallbackPick }) => {
      const fbIndex = fallbackPick === undefined ? 0 : options.indexOf(fallbackPick);
      if (fbIndex < 0) {
        throw new Error('fallbackPick must match one of options');
      }
      const out = await client.choice(
        { question, options },
        { pickedIndex: fbIndex, picked: options[fbIndex] }
      );
      return report(out);
    }
  );

  server.tool(
    'jev_score',
    'Score a subject against named criteria via jev System One (each score in [0,1]).',
    {
      subject: z.string(),
      criteria: z.array(z.string()).min(1),
      fallbackScore: z.number().min(0).max(1).optional().describe('Neutral score used on failure (default 0.5)'),
    },
    async ({ subject, criteria, fallbackScore }) => {
      const fb = fallbackScore ?? 0.5;
      const out = await client.score(
        { subject, criteria },
        { scores: criteria.map(() => fb) }
      );
      return report(out);
    }
  );

  server.tool(
    'jev_noul',
    'Unconstrained jev "noul" reflection on a prompt.',
    {
      prompt: z.string(),
      fallbackText: z.string().optional().describe('Text used if jev is unavailable (default: empty)'),
    },
    async ({ prompt, fallbackText }) => {
      const out = await client.noul({ prompt }, { text: fallbackText ?? '' });
      return report(out);
    }
  );

  return server;
}
