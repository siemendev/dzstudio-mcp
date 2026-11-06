#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ConfigStore } from './config/config.js';
import { Agent } from './mcp/agent.js';
import { createServer } from './mcp/server.js';

const agent = new Agent({ store: new ConfigStore() });
const server = createServer(agent);

async function shutdown(): Promise<void> {
  await agent.shutdown().catch(() => undefined);
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
process.stdin.on('close', () => void shutdown());

await server.connect(new StdioServerTransport());
