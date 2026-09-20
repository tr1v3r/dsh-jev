#!/usr/bin/env node
/**
 * @dsh-jev/mcp — MCP stdio server wrapping @dsh-jev/core.
 *
 * Tools (all degrade, never error the tool call, when System One is unreachable):
 *   - jev_choice: pick one of N options
 *   - jev_score:  score a subject against criteria
 *   - jev_noul:   unconstrained "noul" reflection
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createJevClient } from '@dsh-jev/core';

const client = createJevClient();

const server = new McpServer({ name: 'dsh-jev-mcp', version: '0.1.0' });

function report(out: { ok: boolean; value: unknown; error?: string; durationMs: number }) {
  const status = out.ok ? 'jev: ok' : `jev: degraded (${out.error})`;
  return { content: [{ type: 'text' as const, text: `${status}\n${JSON.stringify(out.value, null, 2)}` }] };
}

server.tool(
  'jev_choice',
  'Pick one option for a decision via jev System One. Degrades to fallbackPick on failure.',
  {
    question: z.string().describe('The decision question'),
    options: z.array(z.string()).min(1).describe('Candidate options'),
    fallbackPick: z.string().optional().describe('Option to use if jev is unavailable (default: first option)'),
  },
  async ({ question, options, fallbackPick }) => {
    const fbIndex = Math.max(0, options.indexOf(fallbackPick ?? options[0]));
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

const transport = new StdioServerTransport();
await server.connect(transport);
