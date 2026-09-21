#!/usr/bin/env node
/**
 * @dsh-jev/mcp CLI — MCP stdio server wrapping @dsh-jev/core.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createJevClient } from '@dsh-jev/core';
import { buildServer } from './server.js';

const server = buildServer(createJevClient());
const transport = new StdioServerTransport();
let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await server.close();
    process.exit(0);
  } catch (error) {
    console.error(`dsh-jev-mcp: failed to shut down after ${signal}:`, error);
    process.exit(1);
  }
}

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => {
  console.error('dsh-jev-mcp: unhandled rejection:', reason);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('dsh-jev-mcp: uncaught exception:', error);
  process.exit(1);
});

try {
  await server.connect(transport);
} catch (error) {
  console.error('dsh-jev-mcp: failed to connect stdio transport:', error);
  process.exit(1);
}
