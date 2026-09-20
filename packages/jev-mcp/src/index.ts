#!/usr/bin/env node
/**
 * @dsh-jev/mcp — MCP stdio server wrapping @dsh-jev/core.
 *
 * Tools (all degrade, never error the tool call, when System One is unreachable):
 *   - jev_choice: pick one of N options
 *   - jev_score:  score a subject against criteria
 *   - jev_noul:   unconstrained "noul" reflection
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createJevClient } from '@dsh-jev/core';
import { buildServer } from './server.js';

const client = createJevClient();
const server = buildServer(client);

const transport = new StdioServerTransport();
await server.connect(transport);
