#!/usr/bin/env node
import fs from 'node:fs';
import { FerryCatEngine } from './engine.js';
import {
  DispatchContractSchema,
  FulfillContractSchema,
  InspectMeshStateSchema,
  PollNextTaskSchema,
} from './schemas.js';

function requireFlagValue(flag: string, value: string | undefined): string {
  if (value === undefined || value.startsWith('--')) {
    throw new Error(`Missing value for CLI flag "${flag}".`);
  }
  return value;
}

function parseArgs(argv: string[]): { command: string; data: Record<string, unknown> } {
  const command = argv[2] || '';
  const rest = argv.slice(3);

  if (rest.length === 1 && !rest[0].startsWith('--')) {
    return { command, data: JSON.parse(rest[0]) };
  }

  const data: Record<string, unknown> = {};
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      const filePath = requireFlagValue('--file', rest[++i]);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      Object.assign(data, JSON.parse(fileContent));
    } else if (token === '--agent') {
      const agent = requireFlagValue('--agent', rest[++i]);
      data.agent_id = agent;
      if (!data.requester_agent) {
        data.requester_agent = agent;
      }
    } else if (token === '--id') {
      data.contract_id = requireFlagValue('--id', rest[++i]);
    } else if (token === '--status') {
      data.status = requireFlagValue('--status', rest[++i]);
    } else if (token === '--limit') {
      const rawLimit = requireFlagValue('--limit', rest[++i]);
      const num = Number(rawLimit);
      if (!Number.isInteger(num)) {
        throw new Error(`Invalid --limit "${rawLimit}": must be an integer.`);
      }
      data.limit = num;
    } else {
      throw new Error(`Unknown CLI argument: "${token}".`);
    }
  }
  return { command, data };
}

const engine = new FerryCatEngine();

try {
  const { command, data } = parseArgs(process.argv);
  let output: unknown;

  switch (command) {
    case 'dispatch':
      output = engine.dispatchContract(DispatchContractSchema.parse(data));
      break;
    case 'poll':
      output = engine.pollNextTask(PollNextTaskSchema.parse(data));
      break;
    case 'fulfill':
      output = engine.fulfillContract(FulfillContractSchema.parse(data));
      break;
    case 'inspect':
      output = engine.inspectMeshState(InspectMeshStateSchema.parse(data));
      break;
    default:
      console.error(
        'Usage: node --experimental-sqlite dist/cli.js <dispatch|poll|fulfill|inspect> [--agent <id>] [--id <contract_id>] [--file <payload.json>]'
      );
      process.exit(1);
  }

  console.log(JSON.stringify(output, null, 2));
} catch (err) {
  console.error(
    JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }, null, 2)
  );
  process.exit(1);
} finally {
  engine.close();
}
