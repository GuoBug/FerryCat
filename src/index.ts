#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { FerryCatEngine } from './engine.js';
import {
  DispatchContractShape,
  ExtendTtlShape,
  FailContractShape,
  FulfillContractShape,
  InspectMeshStateShape,
  PollNextTaskShape,
  ReleaseContractShape,
} from './schemas.js';

const engine = new FerryCatEngine();

const server = new McpServer({
  name: 'ferrycat',
  version: '0.1.1',
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

function toToolResult(run: () => unknown) {
  try {
    const result = run();
    return {
      content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      isError: true,
      content: [
        { type: 'text' as const, text: JSON.stringify({ ok: false, error: message }, null, 2) },
      ],
    };
  }
}

// Tool 5: release_contract
server.tool(
  'release_contract',
  'Hand a CLAIMED contract you hold back to the queue (SUBMITTED, tail position, fresh queue window) when it was claimed by mistake or cannot be handled here. Preserves the contract-level retry_count quota (extend_count is reset for the next holder). Max 3 releases.',
  ReleaseContractShape,
  async (args) => toToolResult(() => engine.releaseContract(args))
);

// Tool 6: extend_ttl
server.tool(
  'extend_ttl',
  'Heartbeat for long-running work: restart the execution window of a CLAIMED contract you hold (max 5 renewals, bounded total lifetime). Must be called before the current window expires.',
  ExtendTtlShape,
  async (args) => toToolResult(() => engine.extendTtl(args))
);

// Tool 7: fail_contract
server.tool(
  'fail_contract',
  'Explicitly mark a CLAIMED contract you hold as terminal FAILED with a reason, so the requester does not wait for the TTL to expire.',
  FailContractShape,
  async (args) => toToolResult(() => engine.failContract(args))
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`[FerryCat Fatal] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
