#!/usr/bin/env node
import { exec } from 'node:child_process';
import fs from 'node:fs';
import { FerryCatEngine } from './engine.js';
import {
  DispatchContractSchema,
  ExtendTtlSchema,
  FailContractSchema,
  FulfillContractSchema,
  InspectMeshStateSchema,
  PollNextTaskSchema,
  ReleaseContractSchema,
  WorkerCommandSchema,
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

  // First pass: if --file is present, load default file payload first
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--file') {
      const filePath = requireFlagValue('--file', rest[++i]);
      const fileContent = fs.readFileSync(filePath, 'utf8');
      Object.assign(data, JSON.parse(fileContent));
    }
  }

  // Second pass: explicit CLI flags always take precedence over --file contents
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i];
    if (token === '--file') {
      i++; // skip already processed file path
    } else if (token === '--agent') {
      const agent = requireFlagValue('--agent', rest[++i]);
      data.agent_id = agent;
    } else if (token === '--id') {
      data.contract_id = requireFlagValue('--id', rest[++i]);
    } else if (token === '--status') {
      data.status = requireFlagValue('--status', rest[++i]);
    } else if (token === '--reason') {
      data.reason = requireFlagValue('--reason', rest[++i]);
    } else if (token === '--limit') {
      const rawLimit = requireFlagValue('--limit', rest[++i]);
      const num = Number(rawLimit);
      if (!Number.isInteger(num)) {
        throw new Error(`Invalid --limit "${rawLimit}": must be an integer.`);
      }
      data.limit = num;
    } else if (token === '--once') {
      data.once = true;
    } else if (token === '--interval') {
      const rawInterval = requireFlagValue('--interval', rest[++i]);
      const num = Number(rawInterval);
      if (!Number.isInteger(num) || num < 100) {
        throw new Error(`Invalid --interval "${rawInterval}": must be an integer >= 100.`);
      }
      data.interval_ms = num;
    } else if (token === '--exec') {
      const cmd = requireFlagValue('--exec', rest[++i]).trim();
      if (!cmd) {
        throw new Error('Invalid --exec value: command cannot be empty.');
      }
      data.exec = cmd;
    } else {
      throw new Error(`Unknown CLI argument: "${token}".`);
    }
  }
  return { command, data };
}

function resolveWorkerIdentity(agentId?: string): string {
  const resolved = (agentId ?? process.env.AGENT_NAME ?? '').trim();
  if (!resolved) {
    throw new Error(
      'Worker identity is missing: please provide it via --agent <id> or set AGENT_NAME environment variable.'
    );
  }
  return resolved;
}

function interruptibleSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout;
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

interface ContractPayload {
  contract_id: string;
  requester_agent: string;
  target_agent: string;
  task_type: string;
  title: string;
  context_summary: string;
  workspace_root: string;
  pointers: unknown[];
  contract_schema: Record<string, unknown> | null;
  claimed_at: number;
  exec_ttl_sec: number;
}

async function executeTaskAndFulfill(
  engine: FerryCatEngine,
  contract: ContractPayload,
  execCmd: string
): Promise<{
  ok: boolean;
  status: string;
  fulfill_result?: unknown;
  error?: string;
  contract_status?: string;
}> {
  return new Promise((resolve) => {
    // Only pass lightweight identifiers via env, keeping payload out of Windows 32KB env block
    const childEnv = {
      ...process.env,
      FERRYCAT_CONTRACT_ID: contract.contract_id,
      FERRYCAT_TASK_TYPE: contract.task_type,
      FERRYCAT_WORKSPACE_ROOT: contract.workspace_root,
      FERRYCAT_TARGET_AGENT: contract.target_agent,
    };

    const timeoutMs = Math.max(10000, contract.exec_ttl_sec * 1000);
    const maxBuffer = 10 * 1024 * 1024; // 10MB to prevent early ENOBUFS kills

    const child = exec(
      execCmd,
      { env: childEnv, timeout: timeoutMs, maxBuffer },
      (err, stdout, stderr) => {
        if (err) {
          const execError = `External exec command failed with code ${err.code ?? 1}${err.killed ? ' (killed after exec timeout)' : ''}: ${stderr || err.message}`;
          // Close the loop explicitly instead of leaving the contract CLAIMED until the TTL sweep
          let contractStatus: string | undefined;
          try {
            contractStatus = engine.failContract({
              contract_id: contract.contract_id,
              agent_id: contract.target_agent,
              reason: execError.slice(0, 2000),
            }).status;
          } catch (failErr) {
            contractStatus = `UNCHANGED (${failErr instanceof Error ? failErr.message : String(failErr)})`;
          }
          return resolve({
            ok: false,
            status: 'EXEC_FAILED',
            error: execError,
            contract_status: contractStatus,
          });
        }

        let structuredOutput: Record<string, unknown> | undefined;
        let resultSummary = stdout.trim();

        try {
          const parsed = JSON.parse(stdout);
          if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
            if (parsed.structured_output && typeof parsed.structured_output === 'object') {
              structuredOutput = parsed.structured_output as Record<string, unknown>;
            } else {
              structuredOutput = parsed as Record<string, unknown>;
            }
            if (parsed.result_summary && typeof parsed.result_summary === 'string') {
              resultSummary = parsed.result_summary;
            }
          }
        } catch {
          // Plain text stdout, fallback to result_summary
        }

        // Bound result_summary to Zod limit
        const boundedSummary = (resultSummary || `Completed via automated worker exec: ${execCmd}`).slice(
          0,
          20000
        );

        try {
          // Strict validation through FulfillContractSchema before passing to engine
          const validatedFulfillInput = FulfillContractSchema.parse({
            contract_id: contract.contract_id,
            agent_id: contract.target_agent,
            result_summary: boundedSummary,
            structured_output: structuredOutput,
          });

          let fulfillRes = engine.fulfillContract(validatedFulfillInput);

          // If RETRY_NEEDED occurs in automated exec, drive to terminal VALIDATION_FAILED
          // to prevent contract from abandoning and lingering in CLAIMED until TTL expiration
          if (fulfillRes.status === 'RETRY_NEEDED') {
            const maxAttempts = (fulfillRes.max_retries ?? 2) + 1;
            for (let i = (fulfillRes.retry_count ?? 1); i < maxAttempts; i++) {
              fulfillRes = engine.fulfillContract(validatedFulfillInput);
              if (fulfillRes.status !== 'RETRY_NEEDED') break;
            }
          }

          resolve({ ok: fulfillRes.ok, status: fulfillRes.status, fulfill_result: fulfillRes });
        } catch (fulfillErr) {
          const fulfillError = fulfillErr instanceof Error ? fulfillErr.message : String(fulfillErr);
          // Best-effort terminal close; fails harmlessly if the contract already left CLAIMED
          let contractStatus: string | undefined;
          try {
            contractStatus = engine.failContract({
              contract_id: contract.contract_id,
              agent_id: contract.target_agent,
              reason: `FULFILL_ERROR: ${fulfillError}`.slice(0, 2000),
            }).status;
          } catch {
            contractStatus = undefined;
          }
          resolve({
            ok: false,
            status: 'FULFILL_ERROR',
            error: fulfillError,
            contract_status: contractStatus,
          });
        }
      }
    );

    // Provide contract payload through stdin with error trap to prevent unhandled EPIPE
    if (child.stdin) {
      child.stdin.on('error', () => {
        // Child process exited without consuming stdin, ignore EPIPE
      });
      child.stdin.write(JSON.stringify(contract));
      child.stdin.end();
    }
  });
}

async function runWorkerLoop(
  engine: FerryCatEngine,
  agentId: string | undefined,
  intervalMs: number,
  execCmd?: string
): Promise<void> {
  const resolvedAgent = resolveWorkerIdentity(agentId);
  const abortController = new AbortController();
  let running = true;
  let sigintCount = 0;
  let lastNotifiedIds = '';

  console.log(
    JSON.stringify({
      status: 'WORKER_STARTED',
      agent_id: resolvedAgent,
      interval_ms: intervalMs,
      mode: execCmd ? 'AUTO_EXEC_AND_FULFILL' : 'WATCHER_ONLY',
      exec_command: execCmd ?? null,
      message: execCmd
        ? `FerryCat worker running in auto-claim & execute mode on agent "${resolvedAgent}"...`
        : `FerryCat worker running in watcher/notifier mode on agent "${resolvedAgent}" (will not claim without --exec)...`,
    })
  );

  const stopHandler = () => {
    sigintCount++;
    if (sigintCount >= 2) {
      console.error(
        JSON.stringify({
          status: 'WORKER_FORCE_EXIT',
          message: 'Second interrupt received, exiting immediately.',
        })
      );
      process.exit(130);
    }
    running = false;
    abortController.abort();
    console.log(
      JSON.stringify({
        status: 'WORKER_STOPPING',
        agent_id: resolvedAgent,
        message: 'Worker stopping gracefully on signal (send again to force)...',
      })
    );
  };

  process.on('SIGINT', stopHandler);
  process.on('SIGTERM', stopHandler);

  while (running) {
    try {
      if (execCmd) {
        // Mode A: Auto-claim and execute
        const pollRes = engine.pollNextTask({ agent_id: resolvedAgent });
        if (pollRes.has_task && pollRes.contract) {
          console.log(
            JSON.stringify({
              event: 'TASK_CLAIMED',
              contract_id: pollRes.contract.contract_id,
              task_type: pollRes.contract.task_type,
              title: pollRes.contract.title,
            })
          );

          const execRes = await executeTaskAndFulfill(
            engine,
            pollRes.contract as unknown as ContractPayload,
            execCmd
          );
          console.log(
            JSON.stringify({
              event: 'TASK_EXECUTION_COMPLETED',
              contract_id: pollRes.contract.contract_id,
              status: execRes.status,
              ok: execRes.ok,
              error: execRes.error ?? null,
              contract_status: execRes.contract_status ?? execRes.status,
            })
          );
        }
      } else {
        // Mode B: Watcher-only mode (inspect up to 100 records without claiming, preventing abandoned tasks)
        const state = engine.inspectMeshState({ status: 'SUBMITTED', limit: 100 });
        const pendingForAgent = state.contracts.filter((c) => c.target_agent === resolvedAgent);
        const currentIds = pendingForAgent.map((c) => c.contract_id).sort().join(',');

        // Deduplicate notifications: only output when pending tasks list actually changes
        if (pendingForAgent.length > 0 && currentIds !== lastNotifiedIds) {
          lastNotifiedIds = currentIds;
          console.log(
            JSON.stringify({
              event: 'PENDING_TASKS_DETECTED',
              agent_id: resolvedAgent,
              pending_count: pendingForAgent.length,
              pending_contracts: pendingForAgent.map((c) => ({
                contract_id: c.contract_id,
                title: c.title,
                created_at: c.created_at,
              })),
              message:
                'Pending tasks detected. Run with --exec <cmd> for automated processing or claim explicitly via poll_next_task.',
            })
          );
        } else if (pendingForAgent.length === 0) {
          lastNotifiedIds = '';
        }
      }
    } catch (err) {
      console.error(
        JSON.stringify({
          event: 'WORKER_CYCLE_ERROR',
          error: err instanceof Error ? err.message : String(err),
        })
      );
    }

    if (running) {
      await interruptibleSleep(intervalMs, abortController.signal);
    }
  }
}

async function main(): Promise<void> {
  const { command, data } = parseArgs(process.argv);
  let engine: FerryCatEngine | undefined;

  try {
    let output: unknown;

    switch (command) {
      case 'dispatch': {
        if (!data.requester_agent && data.agent_id) {
          data.requester_agent = data.agent_id;
        }
        engine = new FerryCatEngine();
        output = engine.dispatchContract(DispatchContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'poll': {
        engine = new FerryCatEngine();
        output = engine.pollNextTask(PollNextTaskSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'fulfill': {
        engine = new FerryCatEngine();
        output = engine.fulfillContract(FulfillContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'inspect': {
        engine = new FerryCatEngine();
        output = engine.inspectMeshState(InspectMeshStateSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'release': {
        engine = new FerryCatEngine();
        output = engine.releaseContract(ReleaseContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'extend': {
        engine = new FerryCatEngine();
        output = engine.extendTtl(ExtendTtlSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'fail': {
        engine = new FerryCatEngine();
        output = engine.failContract(FailContractSchema.parse(data));
        console.log(JSON.stringify(output, null, 2));
        break;
      }
      case 'worker': {
        const validated = WorkerCommandSchema.parse(data);
        const resolvedAgent = resolveWorkerIdentity(validated.agent_id);
        engine = new FerryCatEngine();

        if (validated.once) {
          // Subprocess-per-Task mode
          const pollRes = engine.pollNextTask({ agent_id: resolvedAgent });
          if (!pollRes.has_task || !pollRes.contract) {
            output = {
              has_task: false,
              agent_id: resolvedAgent,
              message: `No pending contracts for agent "${resolvedAgent}".`,
            };
            console.log(JSON.stringify(output, null, 2));
          } else if (validated.exec) {
            // Claim and immediately execute + fulfill
            const execRes = await executeTaskAndFulfill(
              engine,
              pollRes.contract as unknown as ContractPayload,
              validated.exec
            );
            output = {
              has_task: true,
              agent_id: resolvedAgent,
              contract_id: pollRes.contract.contract_id,
              execution: execRes,
            };
            console.log(JSON.stringify(output, null, 2));
          } else {
            // Claim-only mode (Subprocess Claim)
            output = {
              ...pollRes,
              mode: 'CLAIM_ONLY',
              notice:
                'Task claimed. Provide --exec <cmd> to automatically execute and fulfill, or invoke fulfill subcommand.',
            };
            console.log(JSON.stringify(output, null, 2));
          }
        } else {
          // Persistent Worker loop
          await runWorkerLoop(
            engine,
            resolvedAgent,
            validated.interval_ms ?? 1000,
            validated.exec
          );
        }
        break;
      }
      default:
        console.error(
          'Usage: node --experimental-sqlite dist/cli.js <dispatch|poll|fulfill|release|extend|fail|inspect|worker> [--agent <id>] [--id <contract_id>] [--reason <text>] [--file <payload.json>] [--once] [--interval <ms>] [--exec <cmd>]'
        );
        process.exitCode = 1;
        return;
    }
  } catch (err) {
    console.error(
      JSON.stringify(
        { ok: false, error: err instanceof Error ? err.message : String(err) },
        null,
        2
      )
    );
    process.exitCode = 1;
  } finally {
    engine?.close();
  }
}

main().catch((err) => {
  console.error('Fatal CLI Error:', err);
  process.exitCode = 1;
});
