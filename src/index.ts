#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FerryCatEngine } from './engine.js';
import {
  DispatchContractShape,
  FulfillContractShape,
  InspectMeshStateShape,
  PollNextTaskShape,
} from './schemas.js';

const engine = new FerryCatEngine();

const server = new McpServer({
  name: 'ferrycat',
  version: '0.1.0',
});

// Tool 1: dispatch_contract
server.tool(
  'dispatch_contract',
  'Dispatch a contract-driven task or code review handoff to another local AI agent host via SQLite WAL.',
  DispatchContractShape,
  async (args) => {
    try {
      const result = engine.dispatchContract(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 2: poll_next_task
server.tool(
  'poll_next_task',
  'Atomically claim the oldest SUBMITTED contract for this agent and verify local file fingerprints before execution.',
  PollNextTaskShape,
  async (args) => {
    try {
      const result = engine.pollNextTask(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 3: fulfill_contract
server.tool(
  'fulfill_contract',
  'Submit execution or review results for a CLAIMED contract, enforcing JSON Schema validation with bounded retries.',
  FulfillContractShape,
  async (args) => {
    try {
      const result = engine.fulfillContract(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

// Tool 4: inspect_mesh_state
server.tool(
  'inspect_mesh_state',
  'Read-only inspection of contracts, statuses, outputs, and fingerprint/validation failure reasons.',
  InspectMeshStateShape,
  async (args) => {
    try {
      const result = engine.inspectMeshState(args);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [{ type: 'text', text: JSON.stringify({ ok: false, error: message }, null, 2) }],
      };
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[FerryCat Fatal] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
