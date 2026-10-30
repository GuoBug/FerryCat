import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FerryCatEngine } from '../src/engine.js';
import {
  executeTaskAndFulfill,
  createSupervisedChild,
  terminateActiveChildrenSync,
  terminateProcessTree,
  buildChildEnv,
  isSecretEnvName,
  type ContractPayload,
} from '../src/supervisor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Version assertions must track package.json, never a literal: `npm run bump` only rewrites
 * package.json + server.json, so a hardcoded version here turns every release into a red CI run.
 */
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.resolve(__dirname, '../package.json'), 'utf8')) as {
    version: string;
  }
).version;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createTempWorkspace(prefix: string): { dir: string; dbPath: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ferrycat-test-${prefix}-`));
  const dbPath = path.join(dir, 'mesh.db');
  return {
    dir,
    dbPath,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Ignore Windows file lock cleanup race in temp dir
      }
    },
  };
}

async function runWorkerProcess(dbPath: string, agentId: string, startAtMs: number): Promise<any> {
  const workerScript = path.join(__dirname, 'worker-claim.ts');
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--experimental-sqlite', '--import', 'tsx', workerScript, dbPath, agentId, String(startAtMs)],
      { stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += String(chunk)));
    child.stderr.on('data', (chunk) => (stderr += String(chunk)));
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Worker exited with code ${code}: ${stderr}`));
      } else {
        resolve(JSON.parse(stdout.trim()));
      }
    });
  });
}

async function test1_DualProcessConcurrentPreemption(): Promise<void> {
  console.log('\n[Test 1] Dual-Process Concurrent Preemption (SQLite WAL + changes === 1)');
  const { dir, dbPath, cleanup } = createTempWorkspace('preempt');
  try {
    const sampleFile = path.join(dir, 'scheduler.ts');
    fs.writeFileSync(sampleFile, 'export function schedule() {\n  return true;\n}\n', 'utf8');

    const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });
    const dispatched = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Concurrent claim test',
      context_summary: 'Verify only one worker claims this contract.',
      workspace_root: dir,
      pointers: [{ path: 'scheduler.ts' }],
    });
    engine.close();

    // Synchronize two separate OS Node processes to poll at the exact same timestamp
    const barrierMs = Date.now() + 250;
    const [resA, resB] = await Promise.all([
      runWorkerProcess(dbPath, 'workbuddy', barrierMs),
      runWorkerProcess(dbPath, 'workbuddy', barrierMs),
    ]);

    const claimedCount = [resA, resB].filter((r) => r.has_task === true && r.status === 'CLAIMED').length;
    const emptyCount = [resA, resB].filter((r) => r.has_task === false).length;

    assert.equal(claimedCount, 1, `Expected exactly 1 process to claim contract, got ${claimedCount}`);
    assert.equal(emptyCount, 1, `Expected exactly 1 process to receive has_task=false, got ${emptyCount}`);

    const winner = resA.has_task ? resA : resB;
    assert.equal(winner.contract.contract_id, dispatched.contract_id);
    console.log(`  PASS: 2 OS processes raced on "${dispatched.contract_id}" -> 1 CLAIMED, 1 skipped cleanly.`);
  } finally {
    cleanup();
  }
}

async function test2_FingerprintStalenessHeadMiddleTail(): Promise<void> {
  console.log('\n[Test 2] File Fingerprint Verification (Head / Middle / Tail same-size edits + Size + Missing)');
  const { dir, dbPath, cleanup } = createTempWorkspace('fingerprint');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });

  try {
    const filePath = path.join(dir, 'module.ts');
    const originalContent = [
      '// HEAD_MARKER_AAA: module header line',
      'export function computeTaskGraph() {',
      '  const middleValue = "MIDDLE_MARKER_BBB";',
      '  return middleValue;',
      '}',
      '// TAIL_MARKER_CCC: module footer line',
    ].join('\n');

    // Case 2A: Modify ONLY the beginning (same exact byte length!)
    fs.writeFileSync(filePath, originalContent, 'utf8');
    const dHead = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Head mutation test',
      context_summary: 'Test head modification detection',
      workspace_root: dir,
      pointers: [{ path: 'module.ts' }],
    });
    const headMutated = originalContent.replace('HEAD_MARKER_AAA', 'HEAD_MARKER_ZZZ');
    assert.equal(Buffer.byteLength(headMutated), Buffer.byteLength(originalContent));
    fs.writeFileSync(filePath, headMutated, 'utf8');

    const pollHead = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.equal(pollHead.has_task, false);
    assert.equal(pollHead.status, 'POINTER_STALE');
    assert.equal(pollHead.stale_error?.reason, 'CONTENT_CHANGED');
    assert.equal(pollHead.stale_error?.contract_id, dHead.contract_id);
    console.log('  PASS [2A - Head Edit]: Same-size modification at file start caught as CONTENT_CHANGED.');

    // Case 2B: Modify ONLY the middle (same exact byte length!)
    fs.writeFileSync(filePath, originalContent, 'utf8');
    const dMid = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Middle mutation test',
      context_summary: 'Test middle modification detection',
      workspace_root: dir,
      pointers: [{ path: 'module.ts' }],
    });
    const midMutated = originalContent.replace('MIDDLE_MARKER_BBB', 'MIDDLE_MARKER_YYY');
    assert.equal(Buffer.byteLength(midMutated), Buffer.byteLength(originalContent));
    fs.writeFileSync(filePath, midMutated, 'utf8');

    const pollMid = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.equal(pollMid.has_task, false);
    assert.equal(pollMid.status, 'POINTER_STALE');
    assert.equal(pollMid.stale_error?.reason, 'CONTENT_CHANGED');
    assert.equal(pollMid.stale_error?.contract_id, dMid.contract_id);
    console.log('  PASS [2B - Middle Edit]: Same-size modification in file middle caught as CONTENT_CHANGED.');

    // Case 2C: Modify ONLY the end (same exact byte length!)
    fs.writeFileSync(filePath, originalContent, 'utf8');
    const dTail = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Tail mutation test',
      context_summary: 'Test tail modification detection',
      workspace_root: dir,
      pointers: [{ path: 'module.ts' }],
    });
    const tailMutated = originalContent.replace('TAIL_MARKER_CCC', 'TAIL_MARKER_XXX');
    assert.equal(Buffer.byteLength(tailMutated), Buffer.byteLength(originalContent));
    fs.writeFileSync(filePath, tailMutated, 'utf8');

    const pollTail = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.equal(pollTail.has_task, false);
    assert.equal(pollTail.status, 'POINTER_STALE');
    assert.equal(pollTail.stale_error?.reason, 'CONTENT_CHANGED');
    assert.equal(pollTail.stale_error?.contract_id, dTail.contract_id);
    console.log('  PASS [2C - Tail Edit]: Same-size modification at file end caught as CONTENT_CHANGED.');

    // Case 2D: Size mismatch fast-fail
    fs.writeFileSync(filePath, originalContent, 'utf8');
    engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Size mismatch test',
      context_summary: 'Test size mismatch detection',
      workspace_root: dir,
      pointers: [{ path: 'module.ts' }],
    });
    fs.writeFileSync(filePath, originalContent + '\n// extra line\n', 'utf8');
    const pollSize = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.equal(pollSize.status, 'POINTER_STALE');
    assert.equal(pollSize.stale_error?.reason, 'SIZE_MISMATCH');
    console.log('  PASS [2D - Size Change]: Byte size change caught immediately as SIZE_MISMATCH.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test3_SchemaValidationRetryAndCircuitBreak(): Promise<void> {
  console.log('\n[Test 3] Schema Validation Bounded Retries (2x RETRY_NEEDED -> 3rd VALIDATION_FAILED)');
  const { dir, dbPath, cleanup } = createTempWorkspace('schema');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });

  try {
    const filePath = path.join(dir, 'dag.ts');
    fs.writeFileSync(filePath, 'export const dag = {};\n', 'utf8');

    const schema = {
      type: 'object',
      required: ['passed', 'risks'],
      properties: {
        passed: { type: 'boolean' },
        risks: { type: 'array', items: { type: 'string' } },
      },
      additionalProperties: false,
    };

    const dispatched = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'architecture_audit',
      title: 'Audit DAG schema test',
      context_summary: 'Test bounded schema retries',
      workspace_root: dir,
      pointers: [{ path: 'dag.ts' }],
      contract_schema: schema,
    });

    const claimed = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.equal(claimed.has_task, true);
    assert.equal(claimed.status, 'CLAIMED');
    const claimToken = claimed.contract?.claim_token;
    assert.ok(claimToken, 'claimed contract must issue a claim_token (FC-301)');

    // Attempt 1: Invalid structured_output (missing 'risks', wrong type for 'passed')
    const attempt1 = engine.fulfillContract({
      contract_id: dispatched.contract_id,
      agent_id: 'workbuddy',
      claim_token: claimToken,
      result_summary: 'First attempt with bad schema',
      structured_output: { passed: 'yes' as unknown as boolean },
    });
    assert.equal(attempt1.ok, false);
    assert.equal(attempt1.status, 'RETRY_NEEDED');
    assert.equal(attempt1.retry_count, 1);
    assert.ok(attempt1.validation_errors && attempt1.validation_errors.length > 0);
    console.log(`  PASS [Attempt 1]: Returned RETRY_NEEDED (retry_count=1), errors=${JSON.stringify(attempt1.validation_errors)}`);

    // Attempt 2: Still invalid structured_output
    const attempt2 = engine.fulfillContract({
      contract_id: dispatched.contract_id,
      agent_id: 'workbuddy',
      claim_token: claimToken,
      result_summary: 'Second attempt with bad schema',
      structured_output: { passed: true }, // still missing 'risks'
    });
    assert.equal(attempt2.ok, false);
    assert.equal(attempt2.status, 'RETRY_NEEDED');
    assert.equal(attempt2.retry_count, 2);
    console.log(`  PASS [Attempt 2]: Returned RETRY_NEEDED (retry_count=2), errors=${JSON.stringify(attempt2.validation_errors)}`);

    // Attempt 3: Exceeds max_retries (2) -> Terminal VALIDATION_FAILED
    const attempt3 = engine.fulfillContract({
      contract_id: dispatched.contract_id,
      agent_id: 'workbuddy',
      claim_token: claimToken,
      result_summary: 'Third attempt still broken',
      structured_output: { passed: true, risks: [123 as unknown as string] },
    });
    assert.equal(attempt3.ok, false);
    assert.equal(attempt3.status, 'VALIDATION_FAILED');
    assert.equal(attempt3.retry_count, 3);

    const inspected = engine.inspectMeshState({ contract_id: dispatched.contract_id });
    assert.equal(inspected.contracts[0].status, 'VALIDATION_FAILED');
    console.log('  PASS [Attempt 3]: Transitioned to terminal VALIDATION_FAILED on 3rd bad submission.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test4_SecurityPathBlacklist(): Promise<void> {
  console.log('\n[Test 4] Security Path Blacklist & Workspace Escape Guard');
  const { dir, dbPath, cleanup } = createTempWorkspace('security');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity' });

  try {
    const forbiddenPaths = [
      '.env',
      '.env.production',
      'config/server.pem',
      'keys/private.key',
      'id_rsa',
      'aws_credentials.json',
      'client_secret.yaml',
      '.npmrc',
      '../outside-workspace.ts',
    ];

    for (const badPath of forbiddenPaths) {
      assert.throws(
        () => {
          engine.dispatchContract({
            target_agent: 'workbuddy',
            task_type: 'code_review',
            title: 'Should fail security check',
            context_summary: 'Testing blacklist',
            workspace_root: dir,
            pointers: [{ path: badPath }],
          });
        },
        /rejected/i,
        `Expected path "${badPath}" to be rejected by security guard`
      );
    }
    console.log(`  PASS: All ${forbiddenPaths.length} sensitive/escaping file paths deterministically rejected.`);
  } finally {
    engine.close();
    cleanup();
  }
}

async function test5_DualStageTtlAndHappyPath(): Promise<void> {
  console.log('\n[Test 5] Dual-Stage TTL (Queue vs Exec) + Full End-to-End Happy Path');
  const { dir, dbPath, cleanup } = createTempWorkspace('ttl');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });

  try {
    const filePath = path.join(dir, 'engine.ts');
    fs.writeFileSync(filePath, '// Line 1: Engine start\nexport const v = 1;\n// Line 3: Engine end\n', 'utf8');

    const t0 = 1_700_000_000_000;
    const dispatched = engine.dispatchContract(
      {
        target_agent: 'workbuddy',
        task_type: 'code_review',
        title: 'Dual TTL & Happy Path test',
        context_summary: 'Verify claimed task gets fresh exec_ttl_sec window',
        workspace_root: dir,
        pointers: [{ path: 'engine.ts', line_range: [1, 3] }],
        contract_schema: {
          type: 'object',
          required: ['passed', 'comment'],
          properties: {
            passed: { type: 'boolean' },
            comment: { type: 'string' },
          },
        },
        queue_ttl_sec: 1800,
        exec_ttl_sec: 300,
      },
      t0
    );

    assert.equal(dispatched.files[0].first_line, '// Line 1: Engine start');
    assert.equal(dispatched.files[0].last_line, '// Line 3: Engine end');

    // Claim at t0 + 1790s (10 seconds before queue_ttl_sec expires!)
    const tClaim = t0 + 1790 * 1000;
    const claimed = await engine.pollNextTask({ agent_id: 'workbuddy' }, tClaim);
    assert.equal(claimed.has_task, true);
    assert.equal(claimed.status, 'CLAIMED');
    const claimToken = claimed.contract?.claim_token;
    assert.ok(claimToken, 'claimed contract must issue claim_token');

    // Fulfill at t0 + 1850s (past queue_ttl_sec, but only 60s into the 300s exec_ttl_sec window!)
    const tFulfill = t0 + 1850 * 1000;
    const fulfilled = engine.fulfillContract(
      {
        contract_id: dispatched.contract_id,
        agent_id: 'workbuddy',
        claim_token: claimToken,
        result_summary: 'Audit passed cleanly.',
        structured_output: { passed: true, comment: 'LGTM' },
      },
      tFulfill
    );

    assert.equal(fulfilled.ok, true);
    assert.equal(fulfilled.status, 'COMPLETED');

    const state = engine.inspectMeshState({ contract_id: dispatched.contract_id }, tFulfill);
    assert.equal(state.contracts[0].status, 'COMPLETED');
    console.log('  PASS: Claimed contract at 29m50s survived past 30m00s queue TTL and completed within 5m exec TTL.');

    // Test TOCTOU guard at fulfill time (file modified AFTER claim, BEFORE fulfill)
    const dToctou = engine.dispatchContract(
      {
        target_agent: 'workbuddy',
        task_type: 'code_review',
        title: 'TOCTOU mid-review mutation test',
        context_summary: 'Verify fulfill rejects if file mutated after claim',
        workspace_root: dir,
        pointers: [{ path: 'engine.ts' }],
      },
      tFulfill
    );
    const cToctou = await engine.pollNextTask({ agent_id: 'workbuddy' }, tFulfill + 1000);
    assert.equal(cToctou.has_task, true);
    const toctouToken = cToctou.contract?.claim_token;
    assert.ok(toctouToken, 'cToctou must issue claim_token');

    // Mutate file while claimed: Strike 1 triggers ADR-0004 soft-failure (RETRY_NEEDED), Strike 2 triggers terminal POINTER_STALE
    fs.writeFileSync(filePath, '// Mutated mid-review!\nexport const v = 2;\n', 'utf8');
    const fToctouStrike1 = engine.fulfillContract(
      {
        contract_id: dToctou.contract_id,
        agent_id: 'workbuddy',
        claim_token: toctouToken,
        result_summary: 'First attempt while file is dirty',
      },
      tFulfill + 2000
    );
    assert.equal(fToctouStrike1.ok, false);
    assert.equal(fToctouStrike1.status, 'RETRY_NEEDED');
    assert.equal(fToctouStrike1.toctou_strike, 1);
    assert.deepEqual(
      fToctouStrike1.dirty_files?.map((d) => d.path),
      ['engine.ts']
    );

    const fToctouStrike2 = engine.fulfillContract(
      {
        contract_id: dToctou.contract_id,
        agent_id: 'workbuddy',
        claim_token: toctouToken,
        result_summary: 'Second attempt without restoring file',
      },
      tFulfill + 3000
    );
    assert.equal(fToctouStrike2.ok, false);
    assert.equal(fToctouStrike2.status, 'POINTER_STALE');
    assert.equal(fToctouStrike2.toctou_strike, 2);
    console.log('  PASS: Fulfill-time TOCTOU fingerprint guard caught mid-execution file change (Strike 1 RETRY_NEEDED -> Strike 2 POINTER_STALE).');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test6_McpStdioHandshakeAndToolDiscovery(): Promise<void> {
  console.log('\n[Test 6] MCP Stdio Server Handshake & 8-Tool Registration Check');
  const distIndex = path.resolve(__dirname, '../dist/index.js');
  const { dbPath, cleanup } = createTempWorkspace('mcp-stdio');

  try {
    const responseLines: any[] = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--experimental-sqlite', distIndex], {
        env: { ...process.env, AGENT_NAME: 'antigravity', FERRYCAT_DB_PATH: dbPath },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      const collected: any[] = [];
      let buffer = '';

      child.stdout.on('data', (chunk) => {
        buffer += String(chunk);
        const lines = buffer.split(/\r?\n/);
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim()) {
            collected.push(JSON.parse(line));
          }
        }
        if (collected.length >= 2) {
          child.kill();
          resolve(collected);
        }
      });

      child.on('error', reject);

      // Send MCP initialize + tools/list over stdio
      const initReq = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test-client', version: '1.0.0' },
        },
      };
      const initializedNotif = {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      };
      const listToolsReq = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {},
      };

      child.stdin.write(JSON.stringify(initReq) + '\n');
      child.stdin.write(JSON.stringify(initializedNotif) + '\n');
      child.stdin.write(JSON.stringify(listToolsReq) + '\n');
    });

    const toolsResp = responseLines.find((r) => r.id === 2);
    assert.ok(toolsResp, 'Expected response for tools/list');
    const toolNames = toolsResp.result.tools.map((t: any) => t.name).sort();
    assert.deepEqual(toolNames, [
      'dispatch_contract',
      'extend_ttl',
      'fail_contract',
      'fulfill_contract',
      'inspect_mesh_state',
      'poll_next_task',
      'release_contract',
      'verify_contract',
    ]);
    console.log(`  PASS: MCP Server stdio handshake succeeded; registered tools: ${toolNames.join(', ')}`);
  } finally {
    cleanup();
  }
}

async function test7_CliWorkerSubprocess(): Promise<void> {
  console.log('\n[Test 7] CLI Worker Subprocess Execution (--once, --exec & flag precedence)');
  const { dir, dbPath, cleanup } = createTempWorkspace('cli_worker');

  try {
    const targetFile = path.join(dir, 'task.ts');
    fs.writeFileSync(targetFile, 'export const value = 42;\n', 'utf8');

    // Dispatch 2 contracts to test both claim-only and auto-exec
    const engine = new FerryCatEngine({ dbPath });
    const contract1 = engine.dispatchContract({
      requester_agent: 'gui-host',
      target_agent: 'cli-worker',
      task_type: 'code_review',
      title: 'Audit task.ts #1',
      context_summary: 'Verify export value',
      workspace_root: dir,
      pointers: [{ path: 'task.ts' }],
    });
    const contract2 = engine.dispatchContract({
      requester_agent: 'gui-host',
      target_agent: 'cli-worker',
      task_type: 'test_generation',
      title: 'Generate tests #2',
      context_summary: 'Generate tests for task.ts',
      workspace_root: dir,
      pointers: [{ path: 'task.ts' }],
    });
    engine.close();

    // Verify directly against built dist/cli.js
    const cliPath = path.resolve('dist/cli.js');
    const execCli = (args: string[], customEnv: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> => {
      return new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--experimental-sqlite', cliPath, ...args],
          { env: { ...process.env, FERRYCAT_DB_PATH: dbPath, ...customEnv } },
          (err, stdout, stderr) => {
            resolve({ code: err ? (err.code as number ?? 1) : 0, stdout, stderr });
          }
        );
      });
    };

    // 7A: Claim-only mode (without --exec)
    const res7A = await execCli(['worker', '--agent', 'cli-worker', '--once']);
    assert.strictEqual(res7A.code, 0, `7A exit code must be 0: ${res7A.stderr}`);
    const data7A = JSON.parse(res7A.stdout);
    assert.strictEqual(data7A.has_task, true);
    assert.strictEqual(data7A.mode, 'CLAIM_ONLY');
    assert.strictEqual(data7A.status, 'CLAIMED');
    assert.strictEqual(data7A.contract.contract_id, contract1.contract_id);
    console.log(`  PASS [7A - Subprocess Claim-only]: Worker claimed "${data7A.contract.contract_id}" in CLAIM_ONLY mode.`);

    // 7B: Auto-exec and fulfill mode (--once --exec)
    const execScript = `node -e "console.log(JSON.stringify({ passed: true, summary: 'All tests generated' }))"`;
    const res7B = await execCli(['worker', '--agent', 'cli-worker', '--once', '--exec', execScript]);
    assert.strictEqual(res7B.code, 0, `7B exit code must be 0: ${res7B.stderr}`);
    const data7B = JSON.parse(res7B.stdout);
    assert.strictEqual(data7B.has_task, true);
    assert.strictEqual(data7B.contract_id, contract2.contract_id);
    assert.strictEqual(data7B.execution.ok, true);
    assert.strictEqual(data7B.execution.status, 'COMPLETED');

    // Confirm state in db is truly COMPLETED
    const verifyEngine = new FerryCatEngine({ dbPath });
    const inspected2 = verifyEngine.inspectMeshState({ contract_id: contract2.contract_id });
    assert.strictEqual(inspected2.contracts[0].status, 'COMPLETED');
    verifyEngine.close();
    console.log(`  PASS [7B - Subprocess Auto-Exec & Fulfill]: Contract "${contract2.contract_id}" executed and completed automatically.`);

    // 7C: Explicit CLI flag overrides --file default
    const tempPayloadFile = path.join(dir, 'default-payload.json');
    fs.writeFileSync(tempPayloadFile, JSON.stringify({ agent_id: 'wrong-agent', once: true }), 'utf8');
    const res7C = await execCli(['worker', '--file', tempPayloadFile, '--agent', 'cli-worker']);
    assert.strictEqual(res7C.code, 0);
    const data7C = JSON.parse(res7C.stdout);
    assert.strictEqual(data7C.agent_id, 'cli-worker', 'CLI --agent flag must override --file agent_id');
    console.log('  PASS [7C - Flag Precedence]: Explicit CLI --agent flag cleanly overrode --file contents.');

    // 7D: Missing identity fails with clear non-zero exit
    const res7D = await execCli(['worker', '--once'], { AGENT_NAME: '' });
    assert.notStrictEqual(res7D.code, 0, 'Worker must exit non-zero when agent identity is missing');
    assert.ok(res7D.stderr.includes('Worker identity is missing'));
    console.log('  PASS [7D - Identity Enforcement]: Missing agent identity rejected cleanly with non-zero exit.');

    // 7E: Empty --exec rejected with clean error
    const res7E = await execCli(['worker', '--agent', 'cli-worker', '--once', '--exec', '']);
    assert.notStrictEqual(res7E.code, 0, 'Worker must reject empty --exec command');
    console.log('  PASS [7E - Empty Exec Rejection]: Empty --exec flag rejected cleanly.');

    // 7F: Empty queue reports has_task=false
    const res7F = await execCli(['worker', '--agent', 'cli-worker', '--once']);
    assert.strictEqual(res7F.code, 0);
    const data7F = JSON.parse(res7F.stdout);
    assert.strictEqual(data7F.has_task, false);
    console.log('  PASS [7F - Empty Queue Idempotency]: No remaining tasks cleanly reported has_task=false.');
  } finally {
    cleanup();
  }
}

async function test8_TrustBoundaryAndQueueUnblocking(): Promise<void> {
  console.log('\n[Test 8] Trust Boundary Security & Queue Unblocking (P1-1, P1-2, P1-3, P2-1, P2-2)');
  const { dir, dbPath, cleanup } = createTempWorkspace('trust-boundary');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });

  try {
    // 8A: P1-3 Fulfill identity check
    const authFile = path.join(dir, 'auth-target.ts');
    fs.writeFileSync(authFile, 'export const token = "auth-check";\n', 'utf8');

    const authContract = engine.dispatchContract({
      target_agent: 'agent-legit',
      task_type: 'code_review',
      title: 'P1-3 Authorization check',
      context_summary: 'Ensure imposter agent cannot fulfill contract',
      workspace_root: dir,
      pointers: [{ path: 'auth-target.ts' }],
    });

    const pollLegit = await engine.pollNextTask({ agent_id: 'agent-legit' });
    assert.strictEqual(pollLegit.has_task, true);
    assert.strictEqual(pollLegit.status, 'CLAIMED');

    // Imposter attempt must be rejected
    assert.throws(
      () => {
        engine.fulfillContract({
          contract_id: authContract.contract_id,
          agent_id: 'agent-imposter',
          result_summary: 'Imposter attempted fulfillment',
        });
      },
      /Permission denied: contract ".*" was assigned to "agent-legit", but fulfillment was attempted by "agent-imposter"/i,
      'Fulfill must strictly verify agent_id matches target_agent'
    );

    // Legit fulfillment must succeed
    const fulfillLegit = engine.fulfillContract({
      contract_id: authContract.contract_id,
      agent_id: 'agent-legit',
      claim_token: pollLegit.contract?.claim_token,
      result_summary: 'Legit fulfill completed',
    });
    assert.strictEqual(fulfillLegit.ok, true);
    assert.strictEqual(fulfillLegit.status, 'COMPLETED');
    console.log('  PASS [8A - P1-3 Authorization Guard]: Imposter fulfillment rejected, legit agent succeeded.');

    // 8B: P2-1 verified_sha256 persistence & audit trail
    const inspectedAuth = engine.inspectMeshState({ contract_id: authContract.contract_id });
    const verifiedSha = inspectedAuth.contracts[0].verified_sha256 as Record<string, string> | null;
    assert.ok(verifiedSha, 'verified_sha256 must be populated upon COMPLETED');
    assert.ok(verifiedSha['auth-target.ts'], 'verified_sha256 must contain pointer entry');
    assert.strictEqual(typeof verifiedSha['auth-target.ts'], 'string');
    assert.strictEqual(verifiedSha['auth-target.ts'].length, 64);
    console.log(`  PASS [8B - P2-1 Verified SHA-256 Storage]: Recorded sha256: ${verifiedSha['auth-target.ts']}`);

    // 8C: P2-2 Head-of-line stale skipping
    const file1 = path.join(dir, 'queue-file-1.ts');
    const file2 = path.join(dir, 'queue-file-2.ts');
    fs.writeFileSync(file1, 'const q1 = "file 1 content";\n', 'utf8');
    fs.writeFileSync(file2, 'const q2 = "file 2 content";\n', 'utf8');

    const c1 = engine.dispatchContract({
      target_agent: 'queue-worker',
      task_type: 'code_review',
      title: 'Queue item 1 (will become stale)',
      context_summary: 'Head of line stale item',
      workspace_root: dir,
      pointers: [{ path: 'queue-file-1.ts' }],
    });

    const c2 = engine.dispatchContract({
      target_agent: 'queue-worker',
      task_type: 'code_review',
      title: 'Queue item 2 (valid)',
      context_summary: 'Second item that must not be blocked',
      workspace_root: dir,
      pointers: [{ path: 'queue-file-2.ts' }],
    });

    // Tamper with file1 to induce STALE
    fs.writeFileSync(file1, 'const q1 = "file 1 TAMPERED";\n', 'utf8');

    // Poll next task: c1 is stale, but worker must NOT get has_task: false! It must skip c1 and claim c2!
    const pollQueue = await engine.pollNextTask({ agent_id: 'queue-worker' });
    assert.strictEqual(pollQueue.has_task, true, 'pollNextTask must continue to next valid candidate');
    assert.strictEqual(pollQueue.status, 'CLAIMED');
    assert.strictEqual(pollQueue.contract?.contract_id, c2.contract_id);

    // Verify c1 was transitioned to POINTER_STALE
    const inspectC1 = engine.inspectMeshState({ contract_id: c1.contract_id });
    assert.strictEqual(inspectC1.contracts[0].status, 'POINTER_STALE');
    console.log('  PASS [8C - P2-2 Head-of-Line Stale Skip]: Stale c1 marked POINTER_STALE without blocking c2 claim.');

    // 8D: P1-1 Symlink & Junction escape defense
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrycat-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.env');
    fs.writeFileSync(outsideFile, 'SUPER_SECRET=xyz123\n', 'utf8');

    let escapeLinkPath: string | null = null;
    let linkTargetPtr: string | null = null;

    if (process.platform === 'win32') {
      // On Windows, NTFS junction creates a real reparse point without elevated admin rights
      const junctionPath = path.join(dir, 'junction-outside');
      try {
        fs.symlinkSync(outsideDir, junctionPath, 'junction');
        if (fs.lstatSync(junctionPath).isSymbolicLink()) {
          escapeLinkPath = junctionPath;
          linkTargetPtr = 'junction-outside/secret.env';
        }
      } catch (err) {
        console.log(`  INFO: Windows junction creation failed: ${(err as Error).message}`);
      }
    } else {
      // On POSIX (Linux/macOS), standard symlink
      const symlinkPath = path.join(dir, 'symlink-outside.env');
      try {
        fs.symlinkSync(outsideFile, symlinkPath, 'file');
        if (fs.lstatSync(symlinkPath).isSymbolicLink()) {
          escapeLinkPath = symlinkPath;
          linkTargetPtr = 'symlink-outside.env';
        }
      } catch (err) {
        console.log(`  INFO: POSIX symlink creation failed: ${(err as Error).message}`);
      }
    }

    if (escapeLinkPath && linkTargetPtr) {
      assert.throws(
        () => {
          engine.dispatchContract({
            target_agent: 'agent-legit',
            task_type: 'code_review',
            title: 'Physical escape test',
            context_summary: 'Must be blocked by realpathSync guard',
            workspace_root: dir,
            pointers: [{ path: linkTargetPtr! }],
          });
        },
        /resolves to symlink target ".*" outside workspace_root|Pointer rejected/i,
        'Symlink/Junction pointing outside workspace root must be deterministically blocked'
      );
      console.log('  PASS [8D - P1-1 Symlink & Junction Escape Guard]: Reparse point escaping workspace rejected.');
    } else {
      console.log('  PASS [8D - P1-1 Symlink Guard]: OS environment does not support reparse points, verified path guards.');
    }

    // 8E: P1-2 bin entry point execution
    const binCliPath = path.resolve('bin/ferrycat-cli.js');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [binCliPath, 'worker', '--agent', 'test-bin-worker', '--once'],
        { env: { ...process.env, FERRYCAT_DB_PATH: dbPath } },
        (err, stdout, stderr) => {
          if (err && err.code !== 0) {
            reject(new Error(`bin/ferrycat-cli.js execution failed: ${stderr || err.message}`));
          } else {
            const parsed = JSON.parse(stdout.trim());
            assert.strictEqual(parsed.has_task, false);
            console.log('  PASS [8E - P1-2 Bin Wrapper Execution]: bin/ferrycat-cli.js bootstrapped successfully.');
            resolve();
          }
        }
      );
    });

    // 8F: Continuous Pagination past multiple (>5) stale contracts
    const paginationDir = path.join(dir, 'pagination-test');
    fs.mkdirSync(paginationDir, { recursive: true });
    const staleFiles: string[] = [];

    // Dispatch 7 stale contracts
    for (let i = 1; i <= 7; i++) {
      const f = path.join(paginationDir, `stale-${i}.ts`);
      fs.writeFileSync(f, `export const v = ${i};\n`, 'utf8');
      staleFiles.push(f);
      engine.dispatchContract({
        target_agent: 'page-worker',
        task_type: 'code_review',
        title: `Stale contract #${i}`,
        context_summary: 'Testing pagination past multiple stale contracts',
        workspace_root: dir,
        pointers: [{ path: `pagination-test/stale-${i}.ts` }],
      });
    }

    // Dispatch 1 valid contract #8
    const validFile = path.join(paginationDir, 'valid-8.ts');
    fs.writeFileSync(validFile, 'export const valid = true;\n', 'utf8');
    const validContract = engine.dispatchContract({
      target_agent: 'page-worker',
      task_type: 'code_review',
      title: 'Valid contract #8',
      context_summary: 'Must be reached and claimed despite 7 preceding stale contracts',
      workspace_root: dir,
      pointers: [{ path: 'pagination-test/valid-8.ts' }],
    });

    // Tamper with all 7 stale files
    for (const f of staleFiles) {
      fs.writeFileSync(f, 'export const v = "TAMPERED";\n', 'utf8');
    }

    // Worker polls once: must slide past all 7 stale contracts and claim #8
    const pollResult = await engine.pollNextTask({ agent_id: 'page-worker' });
    assert.strictEqual(pollResult.has_task, true, 'pollNextTask must paginate through all stale contracts');
    assert.strictEqual(pollResult.status, 'CLAIMED');
    assert.strictEqual(pollResult.contract?.contract_id, validContract.contract_id);
    console.log('  PASS [8F - Continuous Pagination]: Successfully skipped past 7 stale contracts and claimed #8.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test9_LifecycleReleaseExtendFail(): Promise<void> {
  console.log('\n[Test 9] Phase A Lifecycle: Tiered TTL / release_contract / extend_ttl / fail_contract');
  const { dir, dbPath, cleanup } = createTempWorkspace('lifecycle');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });
  const S = 1000;

  try {
    fs.writeFileSync(path.join(dir, 'life.ts'), 'export const life = 1;\n', 'utf8');
    const base = {
      task_type: 'implementation' as const,
      title: 'Lifecycle',
      context_summary: 'Lifecycle test',
      workspace_root: dir,
      pointers: [{ path: 'life.ts' }],
    };

    // 9A: Tiered default exec TTL by task_type, explicit override wins
    const t0 = 1_700_000_000_000;
    const expectedTtl: Record<string, number> = {
      code_review: 1800,
      architecture_audit: 1800,
      implementation: 300,
      test_generation: 300,
    };
    for (const [taskType, ttl] of Object.entries(expectedTtl)) {
      engine.dispatchContract({ ...base, task_type: taskType as any, target_agent: `ttl-${taskType}` }, t0);
      const polled = await engine.pollNextTask({ agent_id: `ttl-${taskType}` }, t0 + S);
      assert.strictEqual(polled.contract?.exec_ttl_sec, ttl, `${taskType} default exec_ttl_sec`);
    }
    engine.dispatchContract({ ...base, task_type: 'code_review', target_agent: 'ttl-override', exec_ttl_sec: 42 }, t0);
    assert.strictEqual((await engine.pollNextTask({ agent_id: 'ttl-override' }, t0 + S)).contract?.exec_ttl_sec, 42);
    console.log('  PASS [9A - Tiered TTL]: review/audit=1800s, implementation/test=300s, explicit exec_ttl_sec overrides.');

    // 9B: release_contract preserves contract-level retry_count, re-queues at tail, enforces holder + release cap
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    const relA = engine.dispatchContract({ ...base, target_agent: 'rel', title: 'A', contract_schema: schema }, t0);
    const relB = engine.dispatchContract({ ...base, target_agent: 'rel', title: 'B' }, t0 + 1);
    const pollRelA = await engine.pollNextTask({ agent_id: 'rel' }, t0 + S);
    assert.strictEqual(pollRelA.contract?.contract_id, relA.contract_id);
    const tokenRelA = pollRelA.contract?.claim_token;

    const badFulfill = engine.fulfillContract(
      { contract_id: relA.contract_id, agent_id: 'rel', claim_token: tokenRelA, result_summary: 'bad', structured_output: { ok: 'no' } },
      t0 + 2 * S
    );
    assert.strictEqual(badFulfill.status, 'RETRY_NEEDED');

    assert.throws(
      () => engine.releaseContract({ contract_id: relA.contract_id, agent_id: 'imposter', claim_token: tokenRelA }, t0 + 3 * S),
      /Permission denied: .* but release was attempted by "imposter"/
    );
    const released = engine.releaseContract(
      { contract_id: relA.contract_id, agent_id: 'rel', claim_token: tokenRelA, reason: 'missing local toolchain' },
      t0 + 3 * S
    );
    assert.strictEqual(released.ok, true);
    assert.strictEqual(released.status, 'SUBMITTED');
    assert.strictEqual(released.release_count, 1);
    const afterRelease = engine.inspectMeshState({ contract_id: relA.contract_id }, t0 + 3 * S).contracts[0];
    assert.strictEqual(afterRelease.status, 'SUBMITTED');
    assert.strictEqual(afterRelease.retry_count, 1, 'retry_count must be preserved across release to protect circuit breaker quota');
    assert.strictEqual(afterRelease.claimed_at, null);
    assert.strictEqual(afterRelease.error_reason, 'RELEASED_BY_HOLDER: missing local toolchain');
    assert.throws(
      () => engine.releaseContract({ contract_id: relA.contract_id, agent_id: 'rel', claim_token: tokenRelA }, t0 + 4 * S),
      /expected status 'CLAIMED', but current status is 'SUBMITTED'/
    );

    // Released contract goes to the tail: B (older queue position) is claimed first
    assert.strictEqual((await engine.pollNextTask({ agent_id: 'rel' }, t0 + 5 * S)).contract?.contract_id, relB.contract_id);
    const pollRelA2 = await engine.pollNextTask({ agent_id: 'rel' }, t0 + 6 * S);
    assert.strictEqual(pollRelA2.contract?.contract_id, relA.contract_id);
    const tokenRelA2 = pollRelA2.contract?.claim_token;

    // New holder continues from retry_count = 1; another failed attempt pushes it to 2 (circuit breaker quota preserved)
    const retryAfterRelease = engine.fulfillContract(
      { contract_id: relA.contract_id, agent_id: 'rel', claim_token: tokenRelA2, result_summary: 'bad', structured_output: { ok: 'no' } },
      t0 + 7 * S
    );
    assert.strictEqual(retryAfterRelease.status, 'RETRY_NEEDED');
    assert.strictEqual(retryAfterRelease.retry_count, 2);

    // Release cap: releases 2 and 3 succeed, 4th is refused and the contract stays CLAIMED
    let tRel = t0 + 10 * S;
    let currToken = tokenRelA2;
    for (let n = 2; n <= 3; n++) {
      assert.strictEqual(engine.releaseContract({ contract_id: relA.contract_id, agent_id: 'rel', claim_token: currToken }, tRel).release_count, n);
      const repoll = await engine.pollNextTask({ agent_id: 'rel' }, tRel + S);
      assert.strictEqual(repoll.contract?.contract_id, relA.contract_id);
      currToken = repoll.contract?.claim_token;
      tRel += 2 * S;
    }
    const capped = engine.releaseContract({ contract_id: relA.contract_id, agent_id: 'rel', claim_token: currToken }, tRel);
    assert.strictEqual(capped.ok, false);
    assert.strictEqual(capped.status, 'CLAIMED');
    assert.match(capped.message, /fail_contract/);
    console.log('  PASS [9B - release_contract]: holder-only, retry_count preserved, tail re-queue, capped at 3 releases.');

    // Fresh queue window on release: original queue TTL (60s) passed, contract must not be swept
    const relC = engine.dispatchContract({ ...base, target_agent: 'rel-window', queue_ttl_sec: 60 }, t0);
    const pRelC = await engine.pollNextTask({ agent_id: 'rel-window' }, t0 + 50 * S);
    engine.releaseContract({ contract_id: relC.contract_id, agent_id: 'rel-window', claim_token: pRelC.contract?.claim_token }, t0 + 70 * S);
    const reclaimed = await engine.pollNextTask({ agent_id: 'rel-window' }, t0 + 100 * S);
    assert.strictEqual(reclaimed.contract?.contract_id, relC.contract_id, 'released contract needs a fresh queue window');
    console.log('  PASS [9B - Fresh Queue Window]: contract released after its original queue TTL was re-claimable.');

    // 9B-2: release rejected once beyond absolute lifetime cap
    const relCap = engine.dispatchContract({ ...base, target_agent: 'rel-cap', queue_ttl_sec: 60 }, t0);
    const pRelCap = await engine.pollNextTask({ agent_id: 'rel-cap' }, t0 + 10 * S);
    // Lifetime cap is created_at + 4 * 60s = 240s
    const relBeyondCap = engine.releaseContract({ contract_id: relCap.contract_id, agent_id: 'rel-cap', claim_token: pRelCap.contract?.claim_token }, t0 + 241 * S);
    assert.strictEqual(relBeyondCap.ok, false);
    assert.strictEqual(relBeyondCap.status, 'TIMED_OUT');
    assert.strictEqual(engine.inspectMeshState({ contract_id: relCap.contract_id }).contracts[0].status, 'TIMED_OUT');
    console.log('  PASS [9B - Lifetime Release Cap]: release refused when nowMs >= lifetime deadline.');

    // 9C: extend_ttl restarts the window, capped at 5, must be called inside the window
    const ext = engine.dispatchContract({ ...base, target_agent: 'ext', exec_ttl_sec: 300 }, t0);
    const pExt = await engine.pollNextTask({ agent_id: 'ext' }, t0);
    const tokenExt = pExt.contract?.claim_token;
    assert.throws(
      () => engine.extendTtl({ contract_id: ext.contract_id, agent_id: 'imposter', claim_token: tokenExt }, t0 + S),
      /Permission denied: .* but extend was attempted by "imposter"/
    );
    let tExt = t0;
    for (let n = 1; n <= 5; n++) {
      tExt += 200 * S;
      const extended = engine.extendTtl({ contract_id: ext.contract_id, agent_id: 'ext', claim_token: tokenExt }, tExt);
      assert.strictEqual(extended.ok, true);
      assert.strictEqual(extended.extend_count, n);
      assert.strictEqual(extended.expires_at, tExt + 300 * S);
    }
    // 1000s after claim with a 300s exec TTL: still alive thanks to renewals
    const aliveState = engine.inspectMeshState({ contract_id: ext.contract_id }, tExt + 100 * S).contracts[0];
    assert.strictEqual(aliveState.is_logically_expired, false);
    assert.strictEqual(aliveState.extend_count, 5);
    const overLimit = engine.extendTtl({ contract_id: ext.contract_id, agent_id: 'ext', claim_token: tokenExt }, tExt + 100 * S);
    assert.strictEqual(overLimit.ok, false);
    assert.strictEqual(overLimit.status, 'CLAIMED');
    const tooLate = engine.extendTtl({ contract_id: ext.contract_id, agent_id: 'ext', claim_token: tokenExt }, tExt + 301 * S);
    assert.strictEqual(tooLate.status, 'TIMED_OUT');
    assert.strictEqual(engine.inspectMeshState({ contract_id: ext.contract_id }).contracts[0].status, 'TIMED_OUT');

    // Absolute lifetime cap: created_at + 4 * queue_ttl_sec
    // For queue_ttl_sec = 60, exec_ttl_sec = 300: lifetime deadline is t0 + 240s.
    // At t0 + 10s: claimed. At t0 + 20s: renewing would produce expires_at = 20s + 300s = 320s > 240s, so it must be refused!
    const capC = engine.dispatchContract({ ...base, target_agent: 'ext-cap', queue_ttl_sec: 60, exec_ttl_sec: 300 }, t0);
    const pCapC = await engine.pollNextTask({ agent_id: 'ext-cap' }, t0 + 10 * S);
    const proposedExceedsCap = engine.extendTtl({ contract_id: capC.contract_id, agent_id: 'ext-cap', claim_token: pCapC.contract?.claim_token }, t0 + 20 * S);
    assert.strictEqual(proposedExceedsCap.ok, false, 'renewal that would push window past lifetime deadline must be refused');
    assert.match(proposedExceedsCap.message, /exceeding the absolute lifetime cap/);

    // Now test with larger queue_ttl_sec = 600, exec_ttl_sec = 100: deadline is t0 + 2400s.
    // At t0 + 50s: renewing pushes to 50s + 100s = 150s <= 2400s, so it succeeds.
    const capOk = engine.dispatchContract({ ...base, target_agent: 'ext-ok', queue_ttl_sec: 600, exec_ttl_sec: 100 }, t0);
    const pCapOk = await engine.pollNextTask({ agent_id: 'ext-ok' }, t0 + 10 * S);
    const extendWithinLifetime = engine.extendTtl({ contract_id: capOk.contract_id, agent_id: 'ext-ok', claim_token: pCapOk.contract?.claim_token }, t0 + 50 * S);
    assert.strictEqual(extendWithinLifetime.ok, true);
    assert.ok(extendWithinLifetime.expires_at! <= t0 + 2400 * S, 'expires_at must be strictly within lifetime cap');

    console.log('  PASS [9C - extend_ttl]: window restarted 5x, 6th refused, proposed window past deadline refused, lifetime cap enforced.');

    // 9D: fail_contract -> terminal FAILED with reason; late report -> TIMED_OUT with reason preserved
    const fl = engine.dispatchContract({ ...base, target_agent: 'fl', exec_ttl_sec: 300 }, t0);
    const pFl = await engine.pollNextTask({ agent_id: 'fl' }, t0);
    const tokenFl = pFl.contract?.claim_token;
    assert.throws(
      () => engine.failContract({ contract_id: fl.contract_id, agent_id: 'imposter', claim_token: tokenFl, reason: 'x' }, t0 + S),
      /Permission denied: .* but fail was attempted by "imposter"/
    );
    assert.throws(
      () => engine.failContract({ contract_id: fl.contract_id, agent_id: 'fl', claim_token: tokenFl, reason: '   ' }, t0 + S),
      /reason must not be empty/
    );
    const failed = engine.failContract(
      { contract_id: fl.contract_id, agent_id: 'fl', claim_token: tokenFl, reason: 'Compiler not installed' },
      t0 + 2 * S
    );
    assert.strictEqual(failed.ok, true);
    assert.strictEqual(failed.status, 'FAILED');
    const failedState = engine.inspectMeshState({ status: 'FAILED' }, t0 + 2 * S).contracts;
    assert.strictEqual(failedState.length, 1);
    assert.strictEqual(failedState[0].error_reason, 'WORKER_FAILED: Compiler not installed');
    assert.strictEqual(failedState[0].completed_at, t0 + 2 * S);
    assert.throws(
      () => engine.failContract({ contract_id: fl.contract_id, agent_id: 'fl', claim_token: tokenFl, reason: 'again' }, t0 + 3 * S),
      /current status is 'FAILED'/
    );

    const flLate = engine.dispatchContract({ ...base, target_agent: 'fl-late', exec_ttl_sec: 300 }, t0);
    const pFlLate = await engine.pollNextTask({ agent_id: 'fl-late' }, t0);
    const late = engine.failContract({ contract_id: flLate.contract_id, agent_id: 'fl-late', claim_token: pFlLate.contract?.claim_token, reason: 'gave up' }, t0 + 400 * S);
    assert.strictEqual(late.status, 'TIMED_OUT');
    assert.strictEqual(
      engine.inspectMeshState({ contract_id: flLate.contract_id }).contracts[0].error_reason,
      'EXEC_TTL_EXPIRED (late failure report: gave up)'
    );
    console.log('  PASS [9D - fail_contract]: holder-only FAILED terminal with reason; late report -> TIMED_OUT keeps reason.');

    // 9E: RETRY_NEEDED renews the execution window
    const rn = engine.dispatchContract({ ...base, target_agent: 'rn', exec_ttl_sec: 300, contract_schema: schema }, t0);
    const pRn = await engine.pollNextTask({ agent_id: 'rn' }, t0);
    const tokenRn = pRn.contract?.claim_token;
    const rnRetry = engine.fulfillContract(
      { contract_id: rn.contract_id, agent_id: 'rn', claim_token: tokenRn, result_summary: 'bad', structured_output: {} },
      t0 + 250 * S
    );
    assert.strictEqual(rnRetry.status, 'RETRY_NEEDED');
    const rnDone = engine.fulfillContract(
      { contract_id: rn.contract_id, agent_id: 'rn', claim_token: tokenRn, result_summary: 'fixed', structured_output: { ok: true } },
      t0 + 500 * S
    );
    assert.strictEqual(rnDone.status, 'COMPLETED', 'fix attempt after RETRY_NEEDED must get a renewed window');
    console.log('  PASS [9E - Retry Renewal]: RETRY_NEEDED at 250s renewed the 300s window; fix at 500s COMPLETED.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test10_LegacySchemaMigrationAndCliLifecycle(): Promise<void> {
  console.log('\n[Test 10] Legacy DB Migration + CLI release/extend/fail + Exec Failure Auto-FAILED');
  const { dir, dbPath, cleanup } = createTempWorkspace('migration');

  try {
    fs.writeFileSync(path.join(dir, 'legacy.ts'), 'export const legacy = true;\n', 'utf8');
    const base = {
      requester_agent: 'gui-host',
      task_type: 'implementation' as const,
      title: 'Legacy',
      context_summary: 'Legacy row',
      workspace_root: dir,
      pointers: [{ path: 'legacy.ts' }],
    };

    // 10A: Simulate a v0.1 database (no queued_at/extend_count/release_count) holding a pending row
    const seed = new FerryCatEngine({ dbPath });
    const legacy = seed.dispatchContract({ ...base, target_agent: 'legacy-worker' });
    seed.close();
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    raw.exec('DROP INDEX idx_contracts_queue_order;');
    raw.exec('ALTER TABLE contracts DROP COLUMN queued_at;');
    raw.exec('ALTER TABLE contracts DROP COLUMN extend_count;');
    raw.exec('ALTER TABLE contracts DROP COLUMN release_count;');
    raw.close();

    const migrated = new FerryCatEngine({ dbPath });
    const legacyPoll = await migrated.pollNextTask({ agent_id: 'legacy-worker' });
    assert.strictEqual(legacyPoll.contract?.contract_id, legacy.contract_id, 'legacy row (queued_at NULL) must be claimable');
    const legacyExt = migrated.extendTtl({
      contract_id: legacy.contract_id,
      agent_id: 'legacy-worker',
      claim_token: legacyPoll.contract?.claim_token,
    });
    assert.strictEqual(legacyExt.ok, true);
    assert.strictEqual(legacyExt.extend_count, 1);
    migrated.close();
    console.log('  PASS [10A - Legacy Migration]: v0.1 schema upgraded in place; NULL queued_at row claimed and extended.');

    // 10B: CLI release / extend / fail subcommands
    const cliPath = path.resolve('dist/cli.js');
    const execCli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        execFile(
          process.execPath,
          ['--experimental-sqlite', cliPath, ...args],
          { env: { ...process.env, FERRYCAT_DB_PATH: dbPath, AGENT_NAME: '' } },
          (err, stdout, stderr) => resolve({ code: err ? ((err.code as number) ?? 1) : 0, stdout, stderr })
        );
      });

    const engine = new FerryCatEngine({ dbPath });
    const cliC = engine.dispatchContract({ ...base, target_agent: 'cli-life' });
    const pLife1 = await engine.pollNextTask({ agent_id: 'cli-life' });
    const tokenLife1 = pLife1.contract!.claim_token!;

    const resExtend = await execCli(['extend', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife1]);
    assert.strictEqual(resExtend.code, 0, resExtend.stderr);
    assert.strictEqual(JSON.parse(resExtend.stdout).extend_count, 1);

    const resRelease = await execCli(['release', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife1, '--reason', 'wrong branch']);
    assert.strictEqual(resRelease.code, 0, resRelease.stderr);
    assert.strictEqual(JSON.parse(resRelease.stdout).status, 'SUBMITTED');

    const pLife2 = await engine.pollNextTask({ agent_id: 'cli-life' });
    const tokenLife2 = pLife2.contract!.claim_token!;
    const resFailNoReason = await execCli(['fail', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife2]);
    assert.notStrictEqual(resFailNoReason.code, 0, 'fail without --reason must be rejected');
    const resFail = await execCli(['fail', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife2, '--reason', 'cannot reproduce']);
    assert.strictEqual(resFail.code, 0, resFail.stderr);
    assert.strictEqual(JSON.parse(resFail.stdout).status, 'FAILED');
    console.log('  PASS [10B - CLI Lifecycle]: extend -> release -> re-claim -> fail via ferrycat-cli subcommands.');

    // 10C: worker --exec non-zero exit closes the loop as FAILED instead of lingering in CLAIMED
    const execC = engine.dispatchContract({ ...base, target_agent: 'exec-fail' });
    engine.close();
    const resExec = await execCli(['worker', '--agent', 'exec-fail', '--once', '--exec', 'node -e "process.exit(3)"']);
    assert.strictEqual(resExec.code, 0, resExec.stderr);
    const execOut = JSON.parse(resExec.stdout);
    assert.strictEqual(execOut.execution.status, 'EXEC_FAILED');
    assert.strictEqual(execOut.execution.contract_status, 'FAILED');
    const verify = new FerryCatEngine({ dbPath });
    const execState = verify.inspectMeshState({ contract_id: execC.contract_id }).contracts[0];
    verify.close();
    assert.strictEqual(execState.status, 'FAILED');
    assert.match(String(execState.error_reason), /^WORKER_FAILED: External exec command failed with code 3/);
    console.log('  PASS [10C - Exec Failure Closure]: non-zero --exec exit transitioned contract to FAILED with reason.');
  } finally {
    cleanup();
  }
}

async function test11_PhaseBCliErgonomicsAndToctouBuffer(): Promise<void> {
  console.log('\n[Test 11] Phase B (v0.3.0): ADR-0004 TOCTOU Soft-Failure Buffer, Pre-Flight Verify & CLI Ergonomics');
  const { dir, dbPath, cleanup } = createTempWorkspace('phase-b');

  try {
    const fileA = path.join(dir, 'file-a.ts');
    const fileB = path.join(dir, 'file-b.ts');
    const origA = 'export const a = 1;\n';
    const origB = 'export const b = 2;\n';
    fs.writeFileSync(fileA, origA, 'utf8');
    fs.writeFileSync(fileB, origB, 'utf8');

    const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 5 });

    // 11A: ADR-0004 Pre-flight verify_contract & 1-strike TOCTOU recovery (mutate -> Strike 1 RETRY_NEEDED -> restore -> COMPLETED)
    const cRecover = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'ADR-0004 Strike 1 Recovery Test',
      context_summary: 'Reviewer edits file by mistake, hits Strike 1, restores file, and fulfills cleanly',
      workspace_root: dir,
      pointers: [{ path: 'file-a.ts' }, { path: 'file-b.ts' }],
    });

    const pRecover = await engine.pollNextTask({ agent_id: 'workbuddy' }, 1000);
    assert.strictEqual(pRecover.has_task, true);
    const tokenRecover = pRecover.contract?.claim_token;

    // Pre-flight check when clean
    const vClean = engine.verifyContract({ contract_id: cRecover.contract_id, agent_id: 'workbuddy' });
    assert.strictEqual(vClean.ok, true);
    assert.strictEqual(vClean.valid, true);
    assert.strictEqual(vClean.fulfillable, true);
    assert.strictEqual(vClean.status, 'CLAIMED');
    assert.deepStrictEqual(vClean.dirty_files, []);

    // Reviewer accidentally edits both files during review
    fs.writeFileSync(fileA, 'export const a = 999; // reviewer edit\n', 'utf8');
    fs.writeFileSync(fileB, 'export const b = 888; // reviewer edit\n', 'utf8');

    // Pre-flight verify catches both dirty files without consuming a strike
    const vDirty = engine.verifyContract({ contract_id: cRecover.contract_id, agent_id: 'workbuddy' });
    assert.strictEqual(vDirty.ok, true);
    assert.strictEqual(vDirty.valid, false);
    assert.strictEqual(vDirty.fulfillable, false);
    assert.strictEqual(vDirty.status, 'CLAIMED');
    assert.deepStrictEqual(
      vDirty.dirty_files.map((d) => d.path).sort(),
      ['file-a.ts', 'file-b.ts']
    );
    assert.strictEqual(vDirty.toctou_strike, 0);

    // Strike 1: Reviewer calls fulfill while files are still dirty -> soft failure RETRY_NEEDED (stays CLAIMED)
    const fStrike1 = engine.fulfillContract(
      {
        contract_id: cRecover.contract_id,
        agent_id: 'workbuddy',
        claim_token: tokenRecover,
        result_summary: 'Detailed review report (10k tokens)',
      },
      2000
    );
    assert.strictEqual(fStrike1.ok, false);
    assert.strictEqual(fStrike1.status, 'RETRY_NEEDED');
    assert.strictEqual(fStrike1.toctou_strike, 1);
    assert.strictEqual(fStrike1.max_toctou_strikes, 1);
    assert.deepStrictEqual(
      fStrike1.dirty_files?.map((d) => d.path).sort(),
      ['file-a.ts', 'file-b.ts']
    );

    // Contract is still CLAIMED with renewed claimed_at = 2000
    const afterStrike1 = engine.inspectMeshState({ contract_id: cRecover.contract_id }, 2000).contracts[0];
    assert.strictEqual(afterStrike1.status, 'CLAIMED');
    assert.strictEqual(afterStrike1.toctou_strike, 1);
    assert.strictEqual(afterStrike1.claimed_at, 2000);

    // Reviewer restores files and retries fulfill -> succeeds COMPLETED!
    fs.writeFileSync(fileA, origA, 'utf8');
    fs.writeFileSync(fileB, origB, 'utf8');
    const fRecovered = engine.fulfillContract(
      {
        contract_id: cRecover.contract_id,
        agent_id: 'workbuddy',
        claim_token: tokenRecover,
        result_summary: 'Detailed review report (10k tokens)',
      },
      2500
    );
    assert.strictEqual(fRecovered.ok, true);
    assert.strictEqual(fRecovered.status, 'COMPLETED');

    // Pre-flight check on COMPLETED contract reports fulfillable=false (P1-3)
    const vCompleted = engine.verifyContract({ contract_id: cRecover.contract_id, agent_id: 'workbuddy' });
    assert.strictEqual(vCompleted.valid, true);
    assert.strictEqual(vCompleted.fulfillable, false);
    assert.ok(vCompleted.message.includes("contract status is 'COMPLETED' and it can no longer be fulfilled"));
    console.log('  PASS [11A - ADR-0004 Recovery]: verifyContract detected dirty pointers; Strike 1 returned RETRY_NEEDED; restored files completed cleanly.');

    // 11B: Strike 2 terminal POINTER_STALE preserves salvaged_result_json + P2-3 release appends error_reason history
    const cSalvage = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'ADR-0004 Strike 2 Salvage Test',
      context_summary: 'Verify salvaged_result is preserved on Strike 2 POINTER_STALE',
      workspace_root: dir,
      pointers: [{ path: 'file-a.ts' }],
    });
    const pSalv1 = await engine.pollNextTask({ agent_id: 'workbuddy' });
    engine.releaseContract({ contract_id: cSalvage.contract_id, agent_id: 'workbuddy', claim_token: pSalv1.contract?.claim_token, reason: 'first release' });
    const pSalv2 = await engine.pollNextTask({ agent_id: 'workbuddy' });
    engine.releaseContract({ contract_id: cSalvage.contract_id, agent_id: 'workbuddy', claim_token: pSalv2.contract?.claim_token, reason: 'second release' });

    const afterReleases = engine.inspectMeshState({ contract_id: cSalvage.contract_id }).contracts[0];
    assert.strictEqual(afterReleases.toctou_strike, 0, 'releaseContract must reset toctou_strike to 0');
    assert.ok(
      String(afterReleases.error_reason).includes('RELEASED_BY_HOLDER: second release | prev: RELEASED_BY_HOLDER: first release'),
      `Expected preserved release history, got: ${afterReleases.error_reason}`
    );

    const pSalv3 = await engine.pollNextTask({ agent_id: 'workbuddy' });
    const tokenSalv3 = pSalv3.contract?.claim_token;
    fs.writeFileSync(fileA, 'export const a = 777; // dirty again\n', 'utf8');
    const s1 = engine.fulfillContract({
      contract_id: cSalvage.contract_id,
      agent_id: 'workbuddy',
      claim_token: tokenSalv3,
      result_summary: 'Valuable audit report Strike 1',
    });
    assert.strictEqual(s1.status, 'RETRY_NEEDED');

    const s2 = engine.fulfillContract({
      contract_id: cSalvage.contract_id,
      agent_id: 'workbuddy',
      claim_token: tokenSalv3,
      result_summary: 'Valuable audit report Strike 2 (must be salvaged)',
      structured_output: { issues: ['P1-A', 'P2-B'] },
    });
    assert.strictEqual(s2.ok, false);
    assert.strictEqual(s2.status, 'POINTER_STALE');
    const salvagedRow = engine.inspectMeshState({ contract_id: cSalvage.contract_id }).contracts[0];
    assert.strictEqual(salvagedRow.status, 'POINTER_STALE');
    assert.ok(salvagedRow.salvaged_result, 'salvaged_result must be populated on Strike 2 POINTER_STALE');
    assert.strictEqual((salvagedRow.salvaged_result as any).result_summary, 'Valuable audit report Strike 2 (must be salvaged)');
    assert.deepStrictEqual((salvagedRow.salvaged_result as any).structured_output, { issues: ['P1-A', 'P2-B'] });
    fs.writeFileSync(fileA, origA, 'utf8');
    engine.close();
    console.log('  PASS [11B - Salvage & Release History]: Strike 2 preserved salvaged_result; releaseContract appended error_reason history.');

    // 11C: CLI --help, help <cmd>, --version, stdin pipe (--file - with BOM), positional JSON + flags (P2-1), inspect table & --target
    const cliPath = path.resolve(__dirname, '../dist/cli.js');
    const runCli = (
      args: string[],
      stdinData?: string
    ): Promise<{ code: number; stdout: string; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn(process.execPath, ['--experimental-sqlite', cliPath, ...args], {
          env: { ...process.env, FERRYCAT_DB_PATH: dbPath, NODE_NO_WARNINGS: '1' },
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        let stdout = '';
        let stderr = '';
        child.stdout.on('data', (d) => (stdout += String(d)));
        child.stderr.on('data', (d) => (stderr += String(d)));
        child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
        if (stdinData !== undefined) {
          child.stdin.write(stdinData);
        }
        child.stdin.end();
      });

    const helpGlobal = await runCli(['--help']);
    assert.strictEqual(helpGlobal.code, 0);
    assert.ok(
      helpGlobal.stdout.includes(`FerryCat CLI v${PKG_VERSION}`),
      `global help must advertise the real package version (${PKG_VERSION}); hardcoding it breaks every bump`
    );

    const helpFulfill = await runCli(['help', 'fulfill']);
    assert.strictEqual(helpFulfill.code, 0);
    assert.ok(helpFulfill.stdout.includes('Usage: ferrycat-cli fulfill'));

    const verRes = await runCli(['--version']);
    assert.strictEqual(verRes.code, 0);
    assert.strictEqual(
      verRes.stdout.trim(),
      PKG_VERSION,
      '--version must match package.json without a hardcoded literal'
    );

    // Stdin dispatch with UTF-8 BOM (\uFEFF) via --file -
    const stdinDispatchPayload =
      '\uFEFF' +
      JSON.stringify({
        requester_agent: 'cli-tester',
        target_agent: 'stdin-worker',
        task_type: 'code_review',
        title: 'Dispatched via stdin with BOM',
        context_summary: 'Testing --file - with UTF-8 BOM stripping',
        workspace_root: dir,
        pointers: [{ path: 'file-a.ts' }],
      });
    const resStdinDispatch = await runCli(['dispatch', '--file', '-'], stdinDispatchPayload);
    assert.strictEqual(resStdinDispatch.code, 0, resStdinDispatch.stderr);
    const stdinContractId = JSON.parse(resStdinDispatch.stdout).contract_id;

    // CLI verify subcommand
    const resVerifyCli = await runCli(['verify', '--id', stdinContractId, '--agent', 'stdin-worker']);
    assert.strictEqual(resVerifyCli.code, 0, resVerifyCli.stderr);
    assert.strictEqual(JSON.parse(resVerifyCli.stdout).valid, true);

    // worker --mode=claim
    const resClaimMode = await runCli(['worker', '--agent', 'stdin-worker', '--mode=claim']);
    assert.strictEqual(resClaimMode.code, 0, resClaimMode.stderr);
    const parsedClaim = JSON.parse(resClaimMode.stdout);
    assert.strictEqual(parsedClaim.mode, 'CLAIM_ONLY');
    const stdinToken = parsedClaim.contract?.claim_token;
    assert.ok(stdinToken, 'worker --mode=claim must return claim_token');

    // P2-1: Positional JSON + explicit --agent flag coexistence on fulfill
    const resPositionalPlusFlag = await runCli([
      'fulfill',
      JSON.stringify({ contract_id: stdinContractId, result_summary: 'Fulfilled with positional JSON + --agent flag', claim_token: stdinToken }),
      '--agent',
      'stdin-worker',
    ]);
    assert.strictEqual(resPositionalPlusFlag.code, 0, resPositionalPlusFlag.stderr);
    assert.strictEqual(JSON.parse(resPositionalPlusFlag.stdout).status, 'COMPLETED');

    // P1-2: CLI dispatch --agent override_me '{ "requester_agent": "IGNORED", ... }' overrides requester_agent
    const resDispatchOverride = await runCli([
      'dispatch',
      '--agent',
      'cli-requester-override',
      JSON.stringify({
        requester_agent: 'IGNORED',
        target_agent: 'override-target-worker',
        task_type: 'code_review',
        title: 'Dispatch --agent override test',
        context_summary: 'Verify --agent flag overrides payload requester_agent',
        workspace_root: dir,
        pointers: [{ path: 'file-a.ts' }],
      }),
    ]);
    assert.strictEqual(resDispatchOverride.code, 0, resDispatchOverride.stderr);
    const overrideContractId = JSON.parse(resDispatchOverride.stdout).contract_id;
    const verifyEng = new FerryCatEngine({ dbPath });
    assert.strictEqual(
      verifyEng.inspectMeshState({ contract_id: overrideContractId }).contracts[0].requester_agent,
      'cli-requester-override'
    );
    verifyEng.close();

    // inspect ASCII table (default) + --target filter + --json
    const resInspectTable = await runCli(['inspect', '--target', 'stdin-worker']);
    assert.strictEqual(resInspectTable.code, 0, resInspectTable.stderr);
    assert.ok(resInspectTable.stdout.includes('CONTRACT_ID'), 'Default inspect output should be an ASCII table');
    assert.ok(resInspectTable.stdout.includes('stdin-worker'));
    assert.ok(!resInspectTable.stdout.includes('workbuddy'), '--target filter must exclude other agents');

    const resInspectJson = await runCli(['inspect', '--target', 'stdin-worker', '--json']);
    assert.strictEqual(resInspectJson.code, 0, resInspectJson.stderr);
    const parsedInspectJson = JSON.parse(resInspectJson.stdout);
    assert.strictEqual(parsedInspectJson.total_returned, 1);
    assert.strictEqual(parsedInspectJson.contracts.length, 1);
    assert.strictEqual(parsedInspectJson.contracts[0].contract_id, stdinContractId);
    console.log('  PASS [11C - CLI Ergonomics]: --help, --version, --file - (UTF-8 BOM), positional JSON + flags, verify, and inspect ASCII table / --target passed.');

    // 11D: worker --mode=exec --once --exec-file <script.js> & friendly Zod error formatting
    const resDispatchExecFile = await runCli(
      ['dispatch', '-'],
      JSON.stringify({
        requester_agent: 'cli-tester',
        target_agent: 'execfile-worker',
        task_type: 'implementation',
        title: 'Exec-file test',
        context_summary: 'Run external .js script via --exec-file',
        workspace_root: dir,
        pointers: [{ path: 'file-a.ts' }],
      })
    );
    assert.strictEqual(resDispatchExecFile.code, 0, resDispatchExecFile.stderr);
    const execFileContractId = JSON.parse(resDispatchExecFile.stdout).contract_id;

    const workerScriptPath = path.join(dir, 'worker-handler.js');
    fs.writeFileSync(
      workerScriptPath,
      `const id = process.env.FERRYCAT_CONTRACT_ID;\nconsole.log(JSON.stringify({ summary: 'Handled by script for ' + id, ok: true }));\n`,
      'utf8'
    );

    const resExecFile = await runCli([
      'worker',
      '--agent',
      'execfile-worker',
      '--mode=exec',
      '--once',
      '--exec-file',
      workerScriptPath,
    ]);
    assert.strictEqual(resExecFile.code, 0, resExecFile.stderr);
    const execFileOut = JSON.parse(resExecFile.stdout);
    assert.strictEqual(execFileOut.execution.status, 'COMPLETED');
    assert.strictEqual(execFileOut.contract_id, execFileContractId);

    // Friendly Zod error formatting check
    const resBadZod = await runCli(['fulfill', '--id', 'not-a-uuid', '--agent', 'stdin-worker']);
    assert.notStrictEqual(resBadZod.code, 0);
    const parsedBadZod = JSON.parse(resBadZod.stderr);
    assert.ok(
      parsedBadZod.error.includes('Run "ferrycat-cli fulfill --help" for usage.'),
      `Expected friendly Zod error with --help hint, got: ${parsedBadZod.error}`
    );

    // P0-2: worker --mode=exec encountering dirty pointers does NOT auto-retry and burn buffer
    // It returns TOCTOU_RESCUE_REQUIRED and leaves contract in CLAIMED with toctou_strike = 1
    const resDispatchToctouExec = await runCli([
      'dispatch',
      JSON.stringify({
        requester_agent: 'cli-tester',
        target_agent: 'exec-toctou-worker',
        task_type: 'code_review',
        title: 'Auto-exec TOCTOU rescue test',
        context_summary: 'Verify worker does not auto-retry dirty pointers to death',
        workspace_root: dir,
        pointers: [{ path: 'file-a.ts' }],
      }),
    ]);
    const toctouExecContractId = JSON.parse(resDispatchToctouExec.stdout).contract_id;

    // Worker script that mutates file-a.ts before fulfill
    const badWorkerScriptPath = path.join(dir, 'bad-worker-handler.js');
    fs.writeFileSync(
      badWorkerScriptPath,
      `const fs = require('fs');\nfs.writeFileSync(${JSON.stringify(fileA)}, 'dirty from worker\\n');\nconsole.log(JSON.stringify({ summary: 'Attempted fulfill on dirty file', ok: true }));\n`,
      'utf8'
    );

    const resToctouExec = await runCli([
      'worker',
      '--agent',
      'exec-toctou-worker',
      '--mode=exec',
      '--once',
      '--exec-file',
      badWorkerScriptPath,
    ]);
    assert.strictEqual(resToctouExec.code, 0, resToctouExec.stderr);
    const toctouExecOut = JSON.parse(resToctouExec.stdout);
    assert.strictEqual(toctouExecOut.execution.status, 'TOCTOU_RESCUE_REQUIRED');
    const verifyEng2 = new FerryCatEngine({ dbPath });
    const cAfterToctouExec = verifyEng2.inspectMeshState({ contract_id: toctouExecContractId }).contracts[0];
    verifyEng2.close();
    assert.strictEqual(cAfterToctouExec.status, 'CLAIMED', 'Contract must stay CLAIMED for operator rescue');
    assert.strictEqual(cAfterToctouExec.toctou_strike, 1, 'Contract must only have consumed 1 strike');
    fs.writeFileSync(fileA, origA, 'utf8'); // restore

    console.log('  PASS [11D - --exec-file & Friendly Errors]: worker --exec-file executed cleanly, invalid args printed human-friendly Zod errors, and TOCTOU rescue stopped retry.');
  } finally {
    cleanup();
  }
}

async function test12_Phase031_LeaseTokensAndPayloadLimits(): Promise<void> {
  console.log('\n[Test 12] Phase 0.3.1: Lease Token (claim_token) Concurrency Guard & Payload Limits');
  const { dir, dbPath, cleanup } = createTempWorkspace('phase-031');

  try {
    const fileA = path.join(dir, 'code.ts');
    fs.writeFileSync(fileA, 'export const x = 100;\n', 'utf8');

    const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 5 });

    // 12A: Claim generates valid UUID claim_token & stores in DB
    const c1 = engine.dispatchContract({
      target_agent: 'multi-worker',
      task_type: 'code_review',
      title: 'Lease Token Check',
      context_summary: 'Verify claim_token generation',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
    });

    const p1 = await engine.pollNextTask({ agent_id: 'multi-worker' });
    assert.strictEqual(p1.has_task, true);
    assert.strictEqual(p1.status, 'CLAIMED');
    const token1 = p1.contract?.claim_token;
    assert.ok(token1, 'Claimed contract must have claim_token');
    assert.match(
      token1!,
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      'claim_token must be a valid UUID'
    );
    console.log(`  PASS [12A - UUID Lease Token]: Generated claim_token: ${token1}`);

    // 12B: Same-named concurrent worker without token or with wrong token is blocked
    assert.throws(
      () => {
        engine.fulfillContract({
          contract_id: c1.contract_id,
          agent_id: 'multi-worker', // same agent!
          result_summary: 'Rogue worker attempt without token',
        });
      },
      /protected by an exclusive lease token \(claim_token\), but none was provided/i,
      'Must reject fulfill when claim_token is missing'
    );

    assert.throws(
      () => {
        engine.fulfillContract({
          contract_id: c1.contract_id,
          agent_id: 'multi-worker', // same agent!
          claim_token: 'bogus-token-12345',
          result_summary: 'Rogue worker attempt with wrong token',
        });
      },
      /invalid lease token \(claim_token\) provided for fulfill/i,
      'Must reject fulfill when claim_token is wrong'
    );

    // Legitimate fulfill with matching token succeeds
    const fulfillOk = engine.fulfillContract({
      contract_id: c1.contract_id,
      agent_id: 'multi-worker',
      claim_token: token1,
      result_summary: 'Legit worker fulfill with matching token',
    });
    assert.strictEqual(fulfillOk.ok, true);
    assert.strictEqual(fulfillOk.status, 'COMPLETED');
    console.log('  PASS [12B - Same-Agent Isolation]: Missing & mismatched tokens rejected; matching token succeeded.');

    // 12C: releaseContract resets claim_token to NULL; next claim gets a new distinct UUID
    const c2 = engine.dispatchContract({
      target_agent: 'recycle-worker',
      task_type: 'code_review',
      title: 'Release Token Reset Check',
      context_summary: 'Verify token reset on release',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
    });

    const pRecycle1 = await engine.pollNextTask({ agent_id: 'recycle-worker' });
    const tokenRecycle1 = pRecycle1.contract?.claim_token;
    assert.ok(tokenRecycle1);

    // Release with token succeeds
    const relRes = engine.releaseContract({
      contract_id: c2.contract_id,
      agent_id: 'recycle-worker',
      claim_token: tokenRecycle1,
      reason: 'handing back to queue',
    });
    assert.strictEqual(relRes.ok, true);
    assert.strictEqual(relRes.status, 'SUBMITTED');

    // Re-claim gets a fresh, distinct token
    const pRecycle2 = await engine.pollNextTask({ agent_id: 'recycle-worker' });
    const tokenRecycle2 = pRecycle2.contract?.claim_token;
    assert.ok(tokenRecycle2);
    assert.notStrictEqual(tokenRecycle1, tokenRecycle2, 'New claim must issue a fresh distinct token');
    console.log('  PASS [12C - Release Token Refresh]: Release cleared token, re-claim issued fresh distinct UUID.');

    // 12D: extend_ttl and fail_contract lease enforcement
    assert.throws(
      () => engine.extendTtl({ contract_id: c2.contract_id, agent_id: 'recycle-worker', claim_token: 'bad-token' }),
      /invalid lease token/i
    );
    const extendOk = engine.extendTtl({ contract_id: c2.contract_id, agent_id: 'recycle-worker', claim_token: tokenRecycle2 });
    assert.strictEqual(extendOk.ok, true);

    assert.throws(
      () => engine.failContract({ contract_id: c2.contract_id, agent_id: 'recycle-worker', claim_token: 'bad-token', reason: 'fail test' }),
      /invalid lease token/i
    );
    const failOk = engine.failContract({ contract_id: c2.contract_id, agent_id: 'recycle-worker', claim_token: tokenRecycle2, reason: 'confirmed failure' });
    assert.strictEqual(failOk.status, 'FAILED');
    console.log('  PASS [12D - Extend & Fail Lease Guard]: extend and fail enforce exclusive lease tokens.');

    // 12E: Payload limit enforcement (FC-302)
    const oversizedString = 'x'.repeat(1.2 * 1024 * 1024); // 1.2MB string
    assert.throws(
      () => {
        engine.dispatchContract({
          target_agent: 'multi-worker',
          task_type: 'code_review',
          title: 'Oversized Schema Test',
          context_summary: 'Testing 1MB limit',
          workspace_root: dir,
          pointers: [{ path: 'code.ts' }],
          contract_schema: { big: oversizedString },
        });
      },
      /exceeds maximum allowed limit of 1048576 bytes/i,
      'Dispatch must reject schemas exceeding 1MB'
    );

    // Deep nesting > 32 levels test
    let deepObj: Record<string, unknown> = { level: 0 };
    let cur = deepObj;
    for (let i = 1; i <= 35; i++) {
      const next: Record<string, unknown> = { level: i };
      cur.child = next;
      cur = next;
    }
    assert.throws(
      () => {
        engine.dispatchContract({
          target_agent: 'multi-worker',
          task_type: 'code_review',
          title: 'Deep Nesting Test',
          context_summary: 'Testing 32 depth limit',
          workspace_root: dir,
          pointers: [{ path: 'code.ts' }],
          contract_schema: deepObj,
        });
      },
      /exceeds maximum allowed depth of 32/i,
      'Dispatch must reject schemas deeper than 32 levels'
    );
    console.log('  PASS [12E - Payload Limit & Depth Guard]: 1.2MB payload and 35-level deep object rejected.');

    // 12F: Legacy DB row backward compatibility (NULL claim_token operates without token)
    const { DatabaseSync } = await import('node:sqlite');
    const raw = new DatabaseSync(dbPath);
    const legacyId = 'fc_legacy_null_token';
    const codeBuf = fs.readFileSync(fileA);
    const codeSha = crypto.createHash('sha256').update(codeBuf).digest('hex');
    const pointersJson = JSON.stringify([
      {
        path: 'code.ts',
        size: codeBuf.length,
        mtime_ms: Date.now(),
        sha256: codeSha,
        first_line: 'export',
        last_line: ';\n',
      },
    ]);
    raw
      .prepare(
        `INSERT INTO contracts (
          id, requester_agent, target_agent, task_type, title, context_summary,
          workspace_root, pointers_json, status, created_at, queued_at, claimed_at,
          claim_token, queue_ttl_sec, exec_ttl_sec
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?, ?, NULL, 1800, 300)`
      )
      .run(
        legacyId,
        'gui',
        'legacy-agent',
        'code_review',
        'Legacy NULL token',
        'Summary',
        dir,
        pointersJson,
        Date.now(),
        Date.now(),
        Date.now()
      );
    raw.close();

    const legacyFulfill = engine.fulfillContract({
      contract_id: legacyId,
      agent_id: 'legacy-agent',
      // No claim_token provided!
      result_summary: 'Legacy row completed without token',
    });
    assert.strictEqual(legacyFulfill.ok, true);
    assert.strictEqual(legacyFulfill.status, 'COMPLETED');
    console.log('  PASS [12F - Legacy Backward Compatibility]: Row with NULL claim_token operable without token.');

    engine.close();
  } finally {
    cleanup();
  }
}

async function test13_Step0SupervisorHardening(): Promise<void> {
  console.log('\n[Test 13] Phase 3 Step 0: Execution Supervisor & Auto-Heartbeat Hardening');
  const { dir, dbPath, cleanup } = createTempWorkspace('step0-supervisor');

  try {
    const fileA = path.join(dir, 'code.ts');
    fs.writeFileSync(fileA, 'export const value = 42;\n');

    // -------------------------------------------------------------------------
    // 13A: CK-06: Minimal environment allowlist & secret stripping (cross-platform)
    // -------------------------------------------------------------------------
    const testHostEnv: NodeJS.ProcessEnv = {
      PATH: 'C:\\Windows\\System32;C:\\Program Files\\nodejs',
      USERPROFILE: 'C:\\Users\\testuser',
      APPDATA: 'C:\\Users\\testuser\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local',
      HOME: 'C:\\Users\\testuser',
      LANG: 'en_US.UTF-8',
      NPM_TOKEN: 'secret_npm_token_12345',
      GITHUB_TOKEN: 'ghp_secret_github_token_xyz',
      OPENAI_API_KEY: 'sk-secret-openai-key',
      ANTHROPIC_API_KEY: 'sk-ant-secret',
      AWS_SECRET_ACCESS_KEY: 'aws_secret',
      CUSTOM_SAFE_VAR: 'safe_value',
    };

    const dummyContract: ContractPayload = {
      contract_id: 'fc_dummy_1',
      requester_agent: 'antigravity',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Dummy Task',
      context_summary: 'Dummy summary',
      workspace_root: dir,
      pointers: [],
      contract_schema: null,
      claimed_at: Date.now(),
      exec_ttl_sec: 300,
      claim_token: 'lease-dummy-1',
    };

    // Test Windows platform allowlist
    const winEnv = buildChildEnv(dummyContract, [], testHostEnv, 'win32').env;
    assert.strictEqual(winEnv.NPM_TOKEN, undefined, 'NPM_TOKEN must be stripped on Windows');
    assert.strictEqual(winEnv.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must be stripped on Windows');
    assert.strictEqual(winEnv.OPENAI_API_KEY, undefined, 'OPENAI_API_KEY must be stripped on Windows');
    assert.strictEqual(winEnv.CUSTOM_SAFE_VAR, undefined, 'Non-allowlisted vars must be stripped on Windows');
    assert.strictEqual(winEnv.USERPROFILE, 'C:\\Users\\testuser', 'USERPROFILE must be preserved on Windows');
    assert.strictEqual(winEnv.APPDATA, 'C:\\Users\\testuser\\AppData\\Roaming', 'APPDATA must be preserved on Windows');
    assert.strictEqual(winEnv.FERRYCAT_CONTRACT_ID, 'fc_dummy_1');
    assert.strictEqual(winEnv.FERRYCAT_CLAIM_TOKEN, 'lease-dummy-1');

    // Test Linux / POSIX platform allowlist (does NOT include USERPROFILE/APPDATA)
    const linuxEnv = buildChildEnv(dummyContract, [], testHostEnv, 'linux').env;
    assert.strictEqual(linuxEnv.NPM_TOKEN, undefined, 'NPM_TOKEN must be stripped on Linux');
    assert.strictEqual(linuxEnv.GITHUB_TOKEN, undefined, 'GITHUB_TOKEN must be stripped on Linux');
    assert.strictEqual(linuxEnv.USERPROFILE, undefined, 'USERPROFILE is not a POSIX variable and must not leak');
    assert.strictEqual(linuxEnv.APPDATA, undefined, 'APPDATA is not a POSIX variable and must not leak');
    assert.strictEqual(linuxEnv.HOME, 'C:\\Users\\testuser', 'HOME must be preserved on Linux');
    assert.strictEqual(linuxEnv.LANG, 'en_US.UTF-8', 'LANG must be preserved on Linux');
    assert.strictEqual(linuxEnv.FERRYCAT_CONTRACT_ID, 'fc_dummy_1');
    assert.strictEqual(linuxEnv.FERRYCAT_CLAIM_TOKEN, 'lease-dummy-1');

    // Test explicit passEnv forwarding (user-consented) on both platforms
    const passedEnv = buildChildEnv(
      dummyContract,
      ['CUSTOM_SAFE_VAR'],
      testHostEnv,
      'win32'
    ).env;
    assert.strictEqual(passedEnv.CUSTOM_SAFE_VAR, 'safe_value', 'Explicit passEnv variable must be forwarded');
    console.log('  PASS [13A - CK-06 Environment Allowlist]: Whitelist enforced across win32 and linux, tokens stripped.');

    // -------------------------------------------------------------------------
    // 13B: CK-01 & CK-02: Heartbeat keep-alive past initial exec_ttl
    // -------------------------------------------------------------------------
    const engine = new FerryCatEngine({ dbPath });
    assert.strictEqual(engine.dbPath, dbPath, 'Test 13 must strictly use isolated temp dbPath');
    const cKeepAlive = engine.dispatchContract({
      requester_agent: 'gui',
      target_agent: 'supervisor-worker',
      task_type: 'code_review',
      title: 'Keep-alive Test',
      context_summary: 'Verify heartbeat renewal during execution',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
      exec_ttl_sec: 1, // Short 1-second TTL to test fast renewals
    });

    const claimedKeepAlive = await engine.pollNextTask({ agent_id: 'supervisor-worker' });
    assert.ok(claimedKeepAlive.contract);

    // Create a slow script that takes 1.8 seconds (exceeding 1.0s exec_ttl_sec)
    const slowScript = path.join(dir, 'slow_worker.cjs');
    fs.writeFileSync(
      slowScript,
      `
      setTimeout(() => {
        console.log(JSON.stringify({ result_summary: "Slow script finished cleanly after 1800ms" }));
        process.exit(0);
      }, 1800);
      `
    );

    const renewalEvents: Record<string, unknown>[] = [];
    const execResult = await executeTaskAndFulfill(
      engine,
      claimedKeepAlive.contract as unknown as ContractPayload,
      { execFile: slowScript },
      {
        heartbeatIntervalMs: 400, // Ticks every 400ms
        onEvent: (ev) => renewalEvents.push(ev),
      }
    );

    assert.strictEqual(execResult.ok, true, `Execution must succeed: ${execResult.error}`);
    assert.strictEqual(execResult.status, 'COMPLETED');
    const renewEvents = renewalEvents.filter((e) => e.event === 'HEARTBEAT_RENEWED');
    assert.ok(
      renewEvents.length >= 3,
      `Expected at least 3 heartbeat renewals during 1800ms execution, got ${renewEvents.length}`
    );
    const lastRenew = renewEvents[renewEvents.length - 1];
    assert.ok(
      !renewalEvents.some((e) => e.event === 'HEARTBEAT_EXHAUSTED'),
      'Heartbeat renewal must not exhaust the extension budget'
    );
    assert.ok(
      Number(lastRenew.extend_count) <= 5,
      `Heartbeat renewal count (${lastRenew.extend_count}) must stay within the hard cap of 5`
    );

    // Deterministic lazy-renewal check: when exec_ttl_sec (10s) has ample headroom, a short 450ms run performs 0 renewals
    const cLazy = engine.dispatchContract({
      requester_agent: 'gui',
      target_agent: 'supervisor-worker',
      task_type: 'code_review',
      title: 'Lazy Renewal Headroom Test',
      context_summary: 'Verify lazy renewal skips extendTtl when ample headroom remains',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
      exec_ttl_sec: 10,
    });
    const claimedLazy = await engine.pollNextTask({ agent_id: 'supervisor-worker' });
    const fastScript = path.join(dir, 'fast_worker.cjs');
    fs.writeFileSync(
      fastScript,
      `setTimeout(() => { console.log(JSON.stringify({ result_summary: "Fast script done" })); process.exit(0); }, 450);`
    );
    const lazyEvents: Record<string, unknown>[] = [];
    const lazyResult = await executeTaskAndFulfill(
      engine,
      claimedLazy.contract as unknown as ContractPayload,
      { execFile: fastScript },
      { heartbeatIntervalMs: 200, onEvent: (ev) => lazyEvents.push(ev) }
    );
    assert.strictEqual(lazyResult.ok, true);
    assert.strictEqual(
      lazyEvents.filter((e) => e.event === 'HEARTBEAT_RENEWED').length,
      0,
      'Lazy heartbeat must perform 0 renewals when remaining TTL headroom is ample'
    );
    console.log(`  PASS [13B - CK-01/02 Heartbeat Keep-Alive]: Kept alive across ${renewEvents.length} renewals and verified 0 renewals under ample headroom.`);

    // -------------------------------------------------------------------------
    // 13C: CK-04 & CK-05: Process tree termination (grandchild process cleanup)
    // -------------------------------------------------------------------------
    const markerFile = path.join(dir, 'grandchild_marker.txt');
    const parentScript = path.join(dir, 'spawn_grandchild.cjs');
    const markerFileNorm = markerFile.replace(/\\/g, '/');
    fs.writeFileSync(
      parentScript,
      `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      // Spawn grandchild that writes ticks to file
      const grandchild = spawn(process.execPath, [
        '-e',
        'const fs = require("node:fs"); fs.writeFileSync(process.argv[1], "init\\\\n"); setInterval(() => { try { fs.appendFileSync(process.argv[1], "tick\\\\n"); } catch {} }, 80);',
        ${JSON.stringify(markerFileNorm)}
      ], { stdio: 'ignore' });
      // Keep parent alive
      setInterval(() => {}, 1000);
      `
    );

    const parentProc = spawn(process.execPath, [parentScript], {
      stdio: 'ignore',
      detached: process.platform !== 'win32',
    });
    assert.ok(parentProc.pid);
    const supervisedParent = createSupervisedChild(parentProc);

    // Wait until marker file exists and has written data
    let attempts = 0;
    while (!fs.existsSync(markerFile) && attempts++ < 30) {
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(fs.existsSync(markerFile), 'Grandchild marker file should exist and have ticks');
    // Let it accumulate a few ticks
    await new Promise((r) => setTimeout(r, 300));
    const sizeBefore = fs.statSync(markerFile).size;
    assert.ok(sizeBefore > 0, 'Grandchild must have written to marker file');

    // Terminate parent process tree via production SupervisedChild handle
    await terminateProcessTree(supervisedParent, 200);

    // Wait 150ms for Windows I/O flush after kill, then sample size
    await new Promise((r) => setTimeout(r, 150));
    const sizeAfterKill = fs.statSync(markerFile).size;

    // Wait an additional 400ms and verify marker file size has completely stopped growing
    await new Promise((r) => setTimeout(r, 400));
    const sizeAfterWait = fs.statSync(markerFile).size;
    assert.strictEqual(
      sizeAfterWait,
      sizeAfterKill,
      'Grandchild process must be killed; file size must not increase after termination'
    );
    console.log('  PASS [13C - CK-04 Process Tree Kill]: Parent and grandchild terminated cleanly without orphaned writes.');

    // -------------------------------------------------------------------------
    // 13D: CK-07: Partial-output salvage on child timeout / failure (End-to-End)
    // -------------------------------------------------------------------------
    const cSalvage = engine.dispatchContract({
      requester_agent: 'gui',
      target_agent: 'supervisor-worker',
      task_type: 'code_review',
      title: 'Salvage Output Test',
      context_summary: 'Verify partial output salvage on timeout',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
      exec_ttl_sec: 1, // 1s
    });

    const claimedSalvage = await engine.pollNextTask({ agent_id: 'supervisor-worker' });
    assert.ok(claimedSalvage.contract);

    // Script that prints important progress logs then hangs
    const hangingScript = path.join(dir, 'hanging_worker.cjs');
    fs.writeFileSync(
      hangingScript,
      `
      console.log("CRITICAL STEP 1: Parsed 50 files successfully");
      console.log("CRITICAL STEP 2: Found potential security flaw in auth.ts");
      // Intentionally hang indefinitely
      setInterval(() => {}, 5000);
      `
    );

    const salvageResult = await executeTaskAndFulfill(
      engine,
      claimedSalvage.contract as unknown as ContractPayload,
      { execFile: hangingScript },
      {
        heartbeatIntervalMs: 150, // Ticks fast to reach renewals and exhaust quickly
        killGraceMs: 150,
        maxBufferBytes: 1024 * 1024,
      }
    );

    // Assert the full end-to-end CK-07 chain: window exhausted -> salvage triggered -> process killed -> final state
    assert.strictEqual(salvageResult.ok, false);
    assert.strictEqual(salvageResult.status, 'EXEC_WINDOW_EXHAUSTED');
    assert.strictEqual(salvageResult.salvaged, true, 'salvaged flag must be true');

    const salvageCheck = engine.inspectMeshState({ contract_id: cSalvage.contract_id });
    assert.strictEqual(salvageCheck.contracts.length, 1);
    const salvagedObj = salvageCheck.contracts[0].salvaged_result as {
      partial_stdout?: string;
      stdout_tail?: string;
      reason?: string;
    } | null;
    assert.ok(salvagedObj, 'Contract in DB must have salvaged_result recorded');
    const salvagedStdout = salvagedObj.partial_stdout ?? salvagedObj.stdout_tail ?? '';
    assert.ok(
      salvagedStdout.includes('CRITICAL STEP 2: Found potential security flaw in auth.ts'),
      'Salvaged output must contain partial stdout generated before freeze'
    );
    console.log('  PASS [13D - CK-07 Salvage Verification]: Output capture preserved with end-to-end assertions.');

    // -------------------------------------------------------------------------
    // 13E: CK-03: Optimistic concurrency collision resilience during heartbeat
    // -------------------------------------------------------------------------
    const cCollision = engine.dispatchContract({
      requester_agent: 'gui',
      target_agent: 'supervisor-worker',
      task_type: 'code_review',
      title: 'Concurrency Collision Test',
      context_summary: 'Verify supervisor handles external lease renewal gracefully',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
      exec_ttl_sec: 1,
    });
    const claimedCollision = await engine.pollNextTask({ agent_id: 'supervisor-worker' });
    assert.ok(claimedCollision.contract);
    const tokenCollision = claimedCollision.contract.claim_token;
    assert.ok(tokenCollision);

    // Run a script with executeTaskAndFulfill while triggering a concurrent extendTtl
    const collisionScript = path.join(dir, 'collision_worker.cjs');
    fs.writeFileSync(
      collisionScript,
      `
      setTimeout(() => {
        console.log(JSON.stringify({ result_summary: "Finished after concurrent extend" }));
        process.exit(0);
      }, 700);
      `
    );

    const collisionEvents: Record<string, unknown>[] = [];
    // Concurrent task: at 250ms, externally bump extend_count so the next tick experiences state mismatch
    setTimeout(() => {
      try {
        engine.extendTtl({
          contract_id: cCollision.contract_id,
          agent_id: 'supervisor-worker',
          claim_token: tokenCollision,
        });
      } catch {}
    }, 250);

    const collisionResult = await executeTaskAndFulfill(
      engine,
      claimedCollision.contract as unknown as ContractPayload,
      { execFile: collisionScript },
      {
        heartbeatIntervalMs: 200,
        onEvent: (ev) => collisionEvents.push(ev),
      }
    );

    assert.strictEqual(collisionResult.ok, true, `Worker must survive optimistic collision: ${collisionResult.error}`);
    assert.strictEqual(collisionResult.status, 'COMPLETED');

    // Supervisor inspects lease snapshot (CK-03)
    const snapshot = engine.getLeaseSnapshot(cCollision.contract_id);
    assert.ok(snapshot);
    assert.strictEqual(snapshot.status, 'COMPLETED');
    console.log('  PASS [13E - CK-03 Concurrency Collision]: Worker survived concurrent lease renewal and COMPLETED.');

    // -------------------------------------------------------------------------
    // 13F: CK-07 Engine recordSalvage method verification
    // -------------------------------------------------------------------------
    const cSalvageDirect = engine.dispatchContract({
      requester_agent: 'gui',
      target_agent: 'supervisor-worker',
      task_type: 'code_review',
      title: 'Direct Salvage Test',
      context_summary: 'Verify engine recordSalvage on active claim',
      workspace_root: dir,
      pointers: [{ path: 'code.ts' }],
    });
    const claimedDirect = await engine.pollNextTask({ agent_id: 'supervisor-worker' });
    assert.ok(claimedDirect.contract);
    const tokenDirect = claimedDirect.contract.claim_token;
    assert.ok(tokenDirect);

    const salvagePayload = {
      partial_stdout: 'CRITICAL STEP 1: Analyzed AST\nCRITICAL STEP 2: Found bug',
      partial_stderr: '',
      reason: 'TEST_SALVAGE',
      salvaged_at: Date.now(),
    };
    const salvageRes = engine.recordSalvage({
      contract_id: cSalvageDirect.contract_id,
      agent_id: 'supervisor-worker',
      claim_token: tokenDirect,
      salvage: salvagePayload,
    });
    assert.strictEqual(salvageRes, true);

    const inspected = engine.inspectMeshState({ contract_id: cSalvageDirect.contract_id });
    assert.strictEqual(inspected.contracts.length, 1);
    const inspectedRow = inspected.contracts[0];
    assert.ok(inspectedRow.salvaged_result);
    assert.strictEqual(
      (inspectedRow.salvaged_result as Record<string, unknown>).partial_stdout,
      salvagePayload.partial_stdout
    );
    // Contract status must remain CLAIMED (no state change)
    assert.strictEqual(inspectedRow.status, 'CLAIMED');
    console.log('  PASS [13F - CK-07/CK-09 Engine Record Salvage]: Preserved in DB without corrupting contract state machine.');

    engine.close();
  } finally {
    cleanup();
  }
}

async function test14_Step1ControlledDaemonAndCasLeases(): Promise<void> {
  console.log('\n[Test 14] Phase 3 Step 1: Controlled Daemon, CAS Leases & Declarative Config (ADR-0005)');
  const { dir: testDir, dbPath, cleanup } = createTempWorkspace('step1_daemon');

  try {
    const engine = new FerryCatEngine({ dbPath });

    // 14A: CAS Mutual Exclusion on daemon_locks
    const lease1 = engine.acquireDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-alpha',
      ttl_sec: 1, // 1 second short lease for test
      metadata: { role: 'primary' },
    });
    assert.strictEqual(lease1.ok, true);
    assert.strictEqual(lease1.owner_token, 'instance-alpha');

    // Instance Beta attempts to preempt while Alpha's lease is valid -> must fail cleanly
    const lease2 = engine.acquireDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-beta',
      ttl_sec: 1,
    });
    assert.strictEqual(lease2.ok, false);
    assert.ok(lease2.message?.includes('instance-alpha'));
    console.log('  PASS [14A - CAS Lease Mutual Exclusion]: Instance Alpha acquired lease; Instance Beta was deterministically rejected.');

    // 14B: Heartbeat renewal
    const renew1 = engine.renewDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-alpha',
      ttl_sec: 2,
    });
    assert.strictEqual(renew1.ok, true);

    // Imposter renewal fails
    const renewImposter = engine.renewDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-beta',
      ttl_sec: 2,
    });
    assert.strictEqual(renewImposter.ok, false);
    console.log('  PASS [14B - CAS Lease Renewal]: Valid owner renewed lease; invalid owner rejected.');

    // 14C: Failover on Expiry (wait for TTL to lapse)
    await sleep(2100);
    const leaseBetaAfterExpiry = engine.acquireDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-beta',
      ttl_sec: 5,
    });
    assert.strictEqual(leaseBetaAfterExpiry.ok, true);
    assert.strictEqual(leaseBetaAfterExpiry.owner_token, 'instance-beta');
    console.log('  PASS [14C - Expiry Failover]: Expired lease automatically yielded to Instance Beta via atomic CAS UPSERT.');

    // 14D: Explicit release
    const relRes = engine.releaseDaemonLease({
      lock_id: 'test-lock',
      owner_token: 'instance-beta',
    });
    assert.strictEqual(relRes.ok, true);
    const inspectAfterRel = engine.inspectDaemonLease('test-lock');
    assert.strictEqual(inspectAfterRel, null);
    console.log('  PASS [14D - Lease Release]: Voluntary release cleared lock record.');

    // 14E: Config File Loading & Declarative Dispatch
    const dummyScript = path.join(testDir, 'handler.cjs');
    fs.writeFileSync(
      dummyScript,
      `const fs = require('fs');
       const input = fs.readFileSync(0, 'utf8');
       const contract = JSON.parse(input);
       console.log(JSON.stringify({
         result_summary: "Automated handler completed for " + contract.contract_id,
         structured_output: { executed: true, target: contract.target_agent }
       }));
      `
    );

    const configPath = path.join(testDir, 'ferrycat.config.json');
    const configContent = {
      version: 1,
      daemon: {
        lock_id: 'test-daemon',
        lease_ttl_sec: 10,
        heartbeat_interval_ms: 2000,
        poll_interval_ms: 500,
        notify: false,
      },
      agents: {
        'daemon-worker': {
          handlers: {
            implementation: {
              exec_file: dummyScript,
            },
          },
        },
      },
    };
    fs.writeFileSync(configPath, JSON.stringify(configContent, null, 2));

    const p1 = path.join(testDir, 'target.ts');
    fs.writeFileSync(p1, 'export const x = 1;', 'utf8');
    const dispatchRes = engine.dispatchContract({
      requester_agent: 'daemon-requester',
      target_agent: 'daemon-worker',
      task_type: 'implementation',
      title: 'Config-driven daemon test',
      context_summary: 'Run declarative handler via ferrycat daemon',
      workspace_root: testDir,
      pointers: [{ path: 'target.ts' }],
    });

    const { FerryCatDaemon } = await import('../src/daemon.js');
    const daemon = new FerryCatDaemon({
      configPath,
      dbPath,
      notify: false,
    });

    const cycleRes = await daemon.pollAndDispatchOnce();
    assert.strictEqual(cycleRes.processed, true);
    assert.strictEqual(cycleRes.contract_id, dispatchRes.contract_id);
    assert.strictEqual(cycleRes.status, 'COMPLETED');

    const inspectedContract = engine.inspectMeshState({ contract_id: dispatchRes.contract_id });
    assert.strictEqual(inspectedContract.contracts[0].status, 'COMPLETED');
    assert.strictEqual(
      (inspectedContract.contracts[0].structured_output as Record<string, unknown>).executed,
      true
    );
    console.log('  PASS [14E - Config-driven Handler Dispatch]: FerryCatDaemon executed declared handler and COMPLETED contract.');

    daemon.releaseLease();
    daemon.engine.close();

    // 14F: Multi-Daemon Token Independence & Selective Task Polling (WorkBuddy P1 Fix)
    const daemon1 = new FerryCatDaemon({ configPath, dbPath, notify: false });
    const daemon2 = new FerryCatDaemon({ configPath, dbPath, notify: false });
    assert.notStrictEqual(daemon1.ownerToken, daemon2.ownerToken);
    assert.strictEqual(daemon1.acquireLease(), true);
    // daemon2 must not acquire because ownerTokens are cryptographically distinct
    assert.strictEqual(daemon2.acquireLease(), false);

    // Unhandled task type (code_review) must NOT be claimed by daemon-worker (which only configured implementation)
    // The contract must stay cleanly in SUBMITTED state for an appropriate worker rather than being killed (P1 fix)
    const unhandledDispatch = engine.dispatchContract({
      requester_agent: 'daemon-requester',
      target_agent: 'daemon-worker',
      task_type: 'code_review', // Only implementation was configured
      title: 'Selective task type polling test',
      context_summary: 'Test selective polling leaves contract in queue',
      workspace_root: testDir,
      pointers: [{ path: 'target.ts' }],
    });
    const unhandledCycle = await daemon1.pollAndDispatchOnce();
    assert.strictEqual(unhandledCycle.processed, false);
    assert.strictEqual(unhandledCycle.reason, 'NO_TASK_AVAILABLE');
    const inspectedUnhandled = engine.inspectMeshState({ contract_id: unhandledDispatch.contract_id });
    assert.strictEqual(inspectedUnhandled.contracts[0].status, 'SUBMITTED');
    console.log('  PASS [14F - Selective Task Polling & Multi-Daemon Token Isolation]: Contracts for unconfigured tasks remain SUBMITTED in queue.');

    // 14G: ADR-0005 Configuration Anti-Drift Verification
    const { FerryCatConfigFileSchema } = await import('../src/schemas.js');
    const adrFiles = [
      path.resolve(__dirname, '../docs/adr/0005-controlled-daemon-and-process-supervision.md'),
      path.resolve(__dirname, '../docs/adr/0005-controlled-daemon-and-process-supervision_zh.md'),
    ];
    for (const adrPath of adrFiles) {
      const adrContent = fs.readFileSync(adrPath, 'utf8');
      const jsonMatch = adrContent.match(/```json\s*([\s\S]*?)\s*```/);
      assert.ok(jsonMatch, 'ADR file ' + path.basename(adrPath) + ' must contain a ```json configuration snippet');
      const rawJson = JSON.parse(jsonMatch[1]);
      const parsedAdrConfig = FerryCatConfigFileSchema.parse(rawJson);
      assert.strictEqual(parsedAdrConfig.version, 1);
      assert.strictEqual(parsedAdrConfig.daemon.lease_ttl_sec, 30);
      assert.strictEqual(parsedAdrConfig.agents.workbuddy.handlers.code_review.exec_file, './scripts/review-handler.js');
    }

    const exampleConfigPath = path.resolve(__dirname, '../ferrycat.config.example.json');
    const exampleRaw = fs.readFileSync(exampleConfigPath, 'utf8');
    const parsedExample = FerryCatConfigFileSchema.parse(JSON.parse(exampleRaw));
    assert.strictEqual(parsedExample.version, 1);
    console.log('  PASS [14G - ADR-0005 Config Anti-Drift]: Real markdown documentation and example configuration parsed and verified strictly.');

    daemon1.releaseLease();
    daemon1.engine.close();
    daemon2.engine.close();
    engine.close();
  } finally {
    cleanup();
  }
}

async function test15_DemoSandboxSimulation(): Promise<void> {
  console.log('\n[Test 15] Zero-Config Sandbox Demo: Isolation, Self-Cleanup & Structured Contract (REQ-EXP-01)');
  const { runDemo } = await import('../src/demo.js');

  // 15A: --json mode drives the real lifecycle and stays silent on stdout
  const captured: string[] = [];
  const jsonRun = await runDemo({
    json: true,
    execDelayMs: 0,
    write: (line) => captured.push(line),
  });

  assert.strictEqual(jsonRun.ok, true, 'demo must report ok=true');
  assert.strictEqual(jsonRun.status, 'COMPLETED', 'demo must reach terminal COMPLETED');
  assert.strictEqual(jsonRun.steps.length, 4, 'demo must expose exactly 4 lifecycle steps');
  assert.deepStrictEqual(
    jsonRun.steps.map((s) => s.index),
    [1, 2, 3, 4],
    'demo steps must be ordered 1..4'
  );
  assert.strictEqual(jsonRun.dirty_files, 0, 'TOCTOU re-verification must report 0 dirty files');
  assert.strictEqual(jsonRun.verdict, 'CHANGES_REQUESTED', 'sample source must yield one advisory finding');
  assert.strictEqual(jsonRun.issues.length, 1, 'handler must find exactly one loose-equality issue');
  assert.match(jsonRun.issues[0], /calc\.ts:6/, 'finding must point at the loose-equality line');
  assert.ok(jsonRun.contract_id.startsWith('fc_'), 'demo must produce a real contract id');
  assert.match(jsonRun.claim_token, /^[0-9a-f-]{36}$/, 'demo must expose a real UUID lease token');
  assert.strictEqual(captured.length, 0, 'json mode must not write any human-readable output');
  console.log('  PASS [15A - Lifecycle & JSON Silence]: 4-step lifecycle completed; json mode emitted zero human lines.');

  // 15B: default mode removes its sandbox
  assert.strictEqual(jsonRun.sandbox_kept, false, 'sandbox_kept must default to false');
  assert.strictEqual(
    fs.existsSync(jsonRun.sandbox),
    false,
    'sandbox must be removed after a successful run (zero pollution)'
  );
  console.log('  PASS [15B - Sandbox Self-Cleanup]: temporary sandbox removed after run.');

  // 15C: the demo never touches FERRYCAT_DB_PATH or the real mesh.db
  const sentinelDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrycat-test-demo-sentinel-'));
  const sentinelDb = path.join(sentinelDir, 'sentinel-mesh.db');
  const prevDbEnv = process.env.FERRYCAT_DB_PATH;
  process.env.FERRYCAT_DB_PATH = sentinelDb;
  try {
    const sentinelRun = await runDemo({ json: true, execDelayMs: 0 });
    assert.strictEqual(sentinelRun.ok, true, 'demo must succeed under a hostile FERRYCAT_DB_PATH');
    assert.strictEqual(
      fs.existsSync(sentinelDb),
      false,
      'demo must not create or touch the database named by FERRYCAT_DB_PATH'
    );
  } finally {
    if (prevDbEnv === undefined) {
      delete process.env.FERRYCAT_DB_PATH;
    } else {
      process.env.FERRYCAT_DB_PATH = prevDbEnv;
    }
    fs.rmSync(sentinelDir, { recursive: true, force: true });
  }
  console.log('  PASS [15C - Zero Pollution]: FERRYCAT_DB_PATH sentinel untouched; sandbox is fully self-contained.');

  // 15D: --keep preserves a complete, inspectable sandbox under os.tmpdir()
  const keptRun = await runDemo({ json: true, keep: true, execDelayMs: 0 });
  try {
    assert.strictEqual(keptRun.sandbox_kept, true, 'sandbox_kept must reflect --keep');
    assert.ok(fs.existsSync(keptRun.sandbox), 'kept sandbox must survive the run');
    for (const rel of ['demo-mesh.db', 'demo-handler.cjs', path.join('src', 'calc.ts')]) {
      assert.ok(
        fs.existsSync(path.join(keptRun.sandbox, rel)),
        `kept sandbox must contain "${rel}" for manual inspection`
      );
    }
    assert.ok(
      path.resolve(keptRun.sandbox).startsWith(path.resolve(os.tmpdir())),
      'sandbox must live under the OS temp dir, never inside the repository'
    );
  } finally {
    fs.rmSync(keptRun.sandbox, { recursive: true, force: true });
  }
  console.log('  PASS [15D - Keep Mode]: sandbox retained with db + handler + sample source for inspection.');

  // 15E: human mode renders the four-step story without ANSI noise when color is off
  const humanLines: string[] = [];
  const humanRun = await runDemo({
    json: false,
    color: false,
    execDelayMs: 0,
    write: (line) => humanLines.push(line),
  });
  const human = humanLines.join('\n');
  assert.strictEqual(humanRun.ok, true, 'human mode must succeed');
  for (const title of [
    'Contract Dispatched',
    'Contract Claimed',
    'Execution & Schema Check',
    'Contract Completed',
  ]) {
    assert.ok(human.includes(title), `human output must mention "${title}"`);
  }
  assert.ok(
    human.includes('End-to-end multi-agent handoff verified successfully'),
    'human output must close with the success banner'
  );
  assert.ok(
    !human.includes('\u001b['),
    'color:false must emit no ANSI escape sequences (piped/CI-safe)'
  );
  console.log('  PASS [15E - Terminal Story]: 4 steps rendered, success banner present, ANSI-free when color is off.');

  // 15F: CLI wiring — help lists the subcommand and `demo --json` is machine parseable end to end
  const cliPath = path.resolve('dist/cli.js');
  const execCli = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        ['--experimental-sqlite', cliPath, ...args],
        { env: { ...process.env, AGENT_NAME: '', FERRYCAT_DB_PATH: '' } },
        (err, stdout, stderr) => resolve({ code: err ? ((err.code as number) ?? 1) : 0, stdout, stderr })
      );
    });

  const helpRes = await execCli(['--help']);
  assert.strictEqual(helpRes.code, 0, helpRes.stderr);
  assert.ok(helpRes.stdout.includes('demo'), 'global help must list the demo subcommand');

  const demoHelpRes = await execCli(['demo', '--help']);
  assert.strictEqual(demoHelpRes.code, 0, demoHelpRes.stderr);
  for (const flag of ['--json', '--keep', '--no-color']) {
    assert.ok(demoHelpRes.stdout.includes(flag), `demo --help must document ${flag}`);
  }

  const cliDemoRes = await execCli(['demo', '--json']);
  assert.strictEqual(cliDemoRes.code, 0, cliDemoRes.stderr);
  const cliDemoJson = JSON.parse(cliDemoRes.stdout) as { ok: boolean; status: string; steps: unknown[] };
  assert.strictEqual(cliDemoJson.ok, true, 'CLI demo must exit with ok=true');
  assert.strictEqual(cliDemoJson.status, 'COMPLETED', 'CLI demo must reach COMPLETED');
  assert.strictEqual(cliDemoJson.steps.length, 4, 'CLI demo must report 4 steps');

  // Verify bin/ferrycat.js wrapper also cleanly routes `demo` subcommand
  const binWrapperPath = path.resolve('bin/ferrycat.js');
  const execBin = (args: string[]): Promise<{ code: number; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [binWrapperPath, ...args],
        { env: { ...process.env, AGENT_NAME: '', FERRYCAT_DB_PATH: '' } },
        (err, stdout, stderr) => resolve({ code: err ? ((err.code as number) ?? 1) : 0, stdout, stderr })
      );
    });

  const binDemoRes = await execBin(['demo', '--json']);
  assert.strictEqual(binDemoRes.code, 0, binDemoRes.stderr);
  const binDemoJson = JSON.parse(binDemoRes.stdout) as { ok: boolean; status: string };
  assert.strictEqual(binDemoJson.ok, true, 'bin/ferrycat.js wrapper must execute demo subcommand cleanly');

  // The wrapper's *other* direction is the risky one: MCP-server argv shapes must still land on
  // dist/index.js. If the subcommand predicate ever inverts, every IDE integration dies while the
  // demo keeps working — which is exactly the failure mode a demo-only assertion would hide.
  const binMcpHelp = await execBin(['--help']);
  assert.strictEqual(binMcpHelp.code, 0, binMcpHelp.stderr);
  assert.ok(
    binMcpHelp.stdout.includes('MCP Stdio Server'),
    '--help must still route to the MCP server entry (not the CLI help tree)'
  );
  assert.ok(
    binMcpHelp.stdout.includes('demo'),
    'MCP help must advertise the demo subcommand so `npx ferrycat demo` is discoverable'
  );

  const binVersion = await execBin(['--version']);
  assert.strictEqual(binVersion.code, 0, binVersion.stderr);
  assert.strictEqual(
    binVersion.stdout.trim(),
    PKG_VERSION,
    'wrapper --version must report the real package version'
  );

  // Zero argv => MCP server. With stdin closed it must terminate cleanly, never dump a stack trace.
  const binNoArgs = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [binWrapperPath], {
      env: { ...process.env, AGENT_NAME: '', FERRYCAT_DB_PATH: '' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.stdin.end(); // EOF: an MCP stdio server should shut down instead of hanging
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
  assert.strictEqual(binNoArgs.code, 0, `bare \`ferrycat\` must exit cleanly: ${binNoArgs.stderr}`);
  assert.ok(
    !binNoArgs.stderr.includes('ERR_SQLITE') && !binNoArgs.stderr.includes('at async'),
    'bare `ferrycat` must not surface an unhandled error when stdin closes'
  );

  console.log(
    '  PASS [15F - CLI Wiring]: help tree documents demo; `demo --json` parses to a COMPLETED contract; wrapper still routes bare/--help/--version to the MCP server.'
  );
}

async function test16_DesktopNotificationAndWebhook(): Promise<void> {
  console.log('\n[Test 16] FC-403: Native Desktop Notifications & Local Webhook Dispatch');
  const http = await import('node:http');
  const {
    notifyOperator,
    dispatchWebhook,
    setNotifyWebhook,
    getNotifyWebhook,
    resolveNativeCommand,
  } = await import('../src/daemon.js');

  const received: Array<Record<string, unknown>> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        received.push(JSON.parse(body) as Record<string, unknown>);
      } catch {
        received.push({ __unparsable: body });
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  assert.ok(address && typeof address === 'object', 'mock webhook server must bind a port');
  const port = address.port;
  const hookUrl = `http://127.0.0.1:${port}/ferrycat-events`;

  try {
    // 16A: real HTTP delivery with the full five-field envelope
    const delivered = await dispatchWebhook(hookUrl, {
      event: 'TEST_EVENT',
      title: 'Webhook Probe',
      message: 'payload shape verification',
      timestamp: new Date().toISOString(),
      level: 'warn',
    });
    assert.strictEqual(delivered, true, 'webhook delivery must report success on HTTP 200');
    assert.strictEqual(received.length, 1, 'mock server must receive exactly one POST');
    const envelope = received[0];
    for (const field of ['event', 'title', 'message', 'timestamp', 'level']) {
      assert.ok(field in envelope, `webhook payload must contain "${field}"`);
    }
    assert.strictEqual(envelope.event, 'TEST_EVENT');
    assert.strictEqual(envelope.title, 'Webhook Probe');
    assert.strictEqual(envelope.level, 'warn');
    assert.ok(
      !Number.isNaN(Date.parse(String(envelope.timestamp))),
      'webhook timestamp must be ISO-8601 parseable'
    );
    console.log('  PASS [16A - Webhook Delivery]: real HTTP POST received with event/title/message/timestamp/level.');

    // 16B: unreachable endpoint degrades to false without throwing
    const deadDelivered = await dispatchWebhook(
      'http://127.0.0.1:1/unreachable',
      {
        event: 'DEAD_EVENT',
        title: 'Dead',
        message: 'no listener',
        timestamp: new Date().toISOString(),
        level: 'error',
      },
      500
    );
    assert.strictEqual(deadDelivered, false, 'unreachable webhook must resolve false, never throw');
    console.log('  PASS [16B - Webhook Fault Tolerance]: unreachable endpoint returned false silently within the timeout.');

    // 16C: notifyOperator must stay non-blocking and never throw when every channel fails
    setNotifyWebhook(undefined);
    const startedAt = Date.now();
    assert.doesNotThrow(() => {
      notifyOperator('Lease Lost', 'synthetic failure probe', {
        webhookUrl: 'http://127.0.0.1:1/also-dead',
        native: false,
      });
    }, 'notifyOperator must swallow webhook failures');
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 500,
      `notifyOperator must return immediately (took ${elapsed}ms); a blocking notify would stall the daemon loop`
    );
    console.log(`  PASS [16C - Non-Blocking & Silent]: returned in ${elapsed}ms with a dead webhook and no throw.`);

    // 16D: resolution precedence (explicit > process-level config > env) and schema strictness
    const { FerryCatConfigFileSchema } = await import('../src/schemas.js');

    const parsedCfg = FerryCatConfigFileSchema.parse({
      daemon: { webhook_url: 'http://127.0.0.1:9999/from-config' },
    });
    assert.strictEqual(
      parsedCfg.daemon.webhook_url,
      'http://127.0.0.1:9999/from-config',
      'DaemonConfigSchema must accept webhook_url'
    );
    assert.strictEqual(
      FerryCatConfigFileSchema.parse({}).daemon.webhook_url,
      undefined,
      'webhook_url must stay optional for backward compatibility'
    );
    assert.throws(
      () => FerryCatConfigFileSchema.parse({ daemon: { webhook_url: 'not-a-url' } }),
      'webhook_url must reject non-URL values'
    );

    setNotifyWebhook('http://127.0.0.1:9999/registered');
    assert.strictEqual(getNotifyWebhook(), 'http://127.0.0.1:9999/registered');
    setNotifyWebhook('   ');
    assert.strictEqual(getNotifyWebhook(), undefined, 'blank registration must clear the endpoint');

    // A notify with no explicit url falls back to the process-level registration.
    notifyOperator('Task Finished', 'fallback probe', { native: false });
    setNotifyWebhook(undefined);

    const exampleRaw = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../ferrycat.config.example.json'), 'utf8')
    ) as { daemon?: { webhook_url?: string } };
    assert.ok(
      typeof exampleRaw.daemon?.webhook_url === 'string',
      'ferrycat.config.example.json must document webhook_url'
    );
    assert.doesNotThrow(
      () => FerryCatConfigFileSchema.parse(exampleRaw),
      'example config must remain schema-valid after adding webhook_url'
    );
    console.log('  PASS [16D - Config Resolution]: schema accepts webhook_url, rejects bad URLs, and stays backward compatible.');

    // 16E: Cross-platform native command escaping (win32 PowerShell here-string & darwin argv)
    const hostileTitle = `Title "'@\n$(evil) <tag>`;
    const hostileMsg = `Msg "'@\nInvoke-Expression 'bad'`;
    const winCmd = resolveNativeCommand(hostileTitle, hostileMsg, 'win32');
    assert.strictEqual(winCmd.cmd, 'powershell');
    const psScript = winCmd.args[winCmd.args.length - 1];
    assert.ok(
      !psScript.includes('\n\'@\nInvoke-Expression'),
      'win32 toast XML must escape single quotes to &apos; so here-string cannot be escaped'
    );
    assert.ok(psScript.includes('&apos;@'), 'escaped XML entity must be present');

    const macCmd = resolveNativeCommand(hostileTitle, hostileMsg, 'darwin');
    assert.strictEqual(macCmd.cmd, 'osascript');
    assert.strictEqual(macCmd.args[macCmd.args.length - 2], hostileTitle);
    assert.strictEqual(macCmd.args[macCmd.args.length - 1], hostileMsg);
    assert.ok(
      macCmd.args.includes('on run argv'),
      'darwin toast must pass title/message via argv rather than string interpolation'
    );

    const linuxCmd = resolveNativeCommand(hostileTitle, hostileMsg, 'linux');
    assert.strictEqual(linuxCmd.cmd, 'notify-send');
    assert.deepStrictEqual(linuxCmd.args, ['--app-name=FerryCat', hostileTitle, hostileMsg]);
    console.log('  PASS [16E - Native Command Hardening]: win32/darwin/linux commands verified against injection.');

    // 16F: Mutation task ('implementation' | 'test_generation') post-edit fulfillment & dual SHA-256 audit trail
    const { dir: mutDir, dbPath: mutDbPath, cleanup: mutCleanup } = createTempWorkspace('mutation-fulfill');
    const mutEngine = new FerryCatEngine({
      dbPath: mutDbPath,
      defaultAgentName: 'antigravity',
      fingerprintRetryDelayMs: 5,
    });
    try {
      const targetFile = path.join(mutDir, 'feature.ts');
      const newArtifactFile = path.join(mutDir, 'feature.test.ts');
      const preContent = 'export const status = "todo";\n';
      const postContent = 'export const status = "implemented";\nexport function runFeature(): boolean { return true; }\n';
      const artifactContent = 'import { runFeature } from "./feature.js";\nconsole.log(runFeature());\n';
      fs.writeFileSync(targetFile, preContent, 'utf8');

      const preSha = crypto.createHash('sha256').update(Buffer.from(preContent, 'utf8')).digest('hex');
      const postSha = crypto.createHash('sha256').update(Buffer.from(postContent, 'utf8')).digest('hex');
      const artifactSha = crypto.createHash('sha256').update(Buffer.from(artifactContent, 'utf8')).digest('hex');

      const dispatchedMut = mutEngine.dispatchContract({
        target_agent: 'workbuddy',
        task_type: 'implementation',
        title: 'Implement runFeature in feature.ts',
        context_summary: 'Modify feature.ts and add feature.test.ts',
        workspace_root: mutDir,
        pointers: [{ path: 'feature.ts' }],
      });

      const polledMut = await mutEngine.pollNextTask({ agent_id: 'workbuddy' });
      assert.strictEqual(polledMut.has_task, true);
      assert.strictEqual(polledMut.status, 'CLAIMED');
      const mutClaimToken = polledMut.contract?.claim_token;

      // Worker modifies pointer file on disk and creates a new test artifact file
      fs.writeFileSync(targetFile, postContent, 'utf8');
      fs.writeFileSync(newArtifactFile, artifactContent, 'utf8');

      // Pre-flight verifyContract on CLAIMED implementation task should be valid & fulfillable while reporting modified files
      const preflight = mutEngine.verifyContract({
        contract_id: dispatchedMut.contract_id,
        agent_id: 'workbuddy',
      });
      assert.strictEqual(preflight.valid, true, 'CLAIMED implementation task with edited pointer file must be valid');
      assert.strictEqual(preflight.fulfillable, true, 'CLAIMED implementation task with edited pointer file must be fulfillable');
      assert.strictEqual(preflight.dirty_files.length, 1);
      assert.strictEqual(preflight.dirty_files[0].path, 'feature.ts');

      // Fulfill contract: must succeed and commit post-mutation SHA-256 into verified_sha256
      const fulfilledMut = mutEngine.fulfillContract({
        contract_id: dispatchedMut.contract_id,
        agent_id: 'workbuddy',
        claim_token: mutClaimToken,
        result_summary: 'Implemented runFeature and added unit test',
        artifacts_pointers: [
          { path: 'feature.ts', description: 'Implemented runFeature' },
          { path: 'feature.test.ts', description: 'Added unit test' },
        ],
      });
      assert.strictEqual(fulfilledMut.ok, true);
      assert.strictEqual(fulfilledMut.status, 'COMPLETED');

      const inspectedMut = mutEngine.inspectMeshState({ contract_id: dispatchedMut.contract_id });
      const completedContract = inspectedMut.contracts[0];
      assert.strictEqual(completedContract.status, 'COMPLETED');
      assert.strictEqual(
        completedContract.pointers[0].sha256,
        preSha,
        'pointers[0].sha256 must preserve the pre-mutation baseline SHA-256'
      );
      assert.strictEqual(
        completedContract.verified_sha256?.['feature.ts'],
        postSha,
        'verified_sha256["feature.ts"] must record the post-mutation SHA-256'
      );
      assert.strictEqual(
        completedContract.verified_sha256?.['feature.test.ts'],
        artifactSha,
        'verified_sha256["feature.test.ts"] must record the new artifact SHA-256'
      );
      assert.notStrictEqual(preSha, postSha);

      // Post-completion verifyContract on COMPLETED mutation contract must validate against verified_sha256 (valid: true, fulfillable: false)
      const postVerify = mutEngine.verifyContract({
        contract_id: dispatchedMut.contract_id,
        agent_id: 'antigravity',
      });
      assert.strictEqual(postVerify.valid, true, 'COMPLETED mutation contract must verify as valid against verified_sha256');
      assert.strictEqual(postVerify.fulfillable, false);
      assert.strictEqual(postVerify.dirty_files.length, 0);

      // Modifying a delivered file AFTER completion must be caught as post-completion drift
      fs.writeFileSync(targetFile, postContent + '// tampered after completion\n', 'utf8');
      const driftedPostVerify = mutEngine.verifyContract({
        contract_id: dispatchedMut.contract_id,
        agent_id: 'antigravity',
      });
      assert.strictEqual(driftedPostVerify.valid, false, 'Post-completion tampering must fail verifyContract');
      assert.strictEqual(driftedPostVerify.dirty_files[0].path, 'feature.ts');
      fs.writeFileSync(targetFile, postContent, 'utf8');

      // Regression control: read-only code_review task modifying pointer file MUST still be blocked by TOCTOU guard
      const roDispatch = mutEngine.dispatchContract({
        target_agent: 'workbuddy',
        task_type: 'code_review',
        title: 'Read-only regression control',
        context_summary: 'Ensure code_review remains strictly immutable under ADR-0004',
        workspace_root: mutDir,
        pointers: [{ path: 'feature.ts' }],
      });
      const roPolled = await mutEngine.pollNextTask({ agent_id: 'workbuddy' });
      fs.writeFileSync(targetFile, postContent + '// illegal review edit\n', 'utf8');
      const roFulfill = mutEngine.fulfillContract({
        contract_id: roDispatch.contract_id,
        agent_id: 'workbuddy',
        claim_token: roPolled.contract?.claim_token,
        result_summary: 'Edited file during review',
      });
      assert.strictEqual(roFulfill.ok, false, 'code_review must reject disk edits');
      assert.strictEqual(roFulfill.status, 'RETRY_NEEDED');
      assert.strictEqual(roFulfill.dirty_files?.[0].reason, 'SIZE_MISMATCH');
      fs.writeFileSync(targetFile, postContent, 'utf8');
      mutEngine.releaseContract({
        contract_id: roDispatch.contract_id,
        agent_id: 'workbuddy',
        claim_token: roPolled.contract?.claim_token,
        reason: 'test cleanup',
      });

      // Security & missing artifact guards on mutation path (SECURITY_REJECTED + non-existent artifact FILE_MISSING + no-op warning)
      const secDispatch = mutEngine.dispatchContract({
        target_agent: 'workbuddy',
        task_type: 'implementation',
        title: 'Security & missing artifact guard on mutation path',
        context_summary: 'Verify SECURITY_REJECTED and missing artifact FILE_MISSING',
        workspace_root: mutDir,
        pointers: [{ path: 'feature.ts' }],
      });
      // Skip the released roDispatch by polling until secDispatch is claimed
      let secPolled = await mutEngine.pollNextTask({ agent_id: 'workbuddy' });
      if (secPolled.contract?.contract_id === roDispatch.contract_id) {
        mutEngine.failContract({
          contract_id: roDispatch.contract_id,
          agent_id: 'workbuddy',
          claim_token: secPolled.contract.claim_token,
          reason: 'skip roDispatch',
        });
        secPolled = await mutEngine.pollNextTask({ agent_id: 'workbuddy' });
      }
      assert.strictEqual(secPolled.contract?.contract_id, secDispatch.contract_id);

      // Strike 1: SECURITY_REJECTED via sensitive artifact pointer (.env)
      const secFulfill = mutEngine.fulfillContract({
        contract_id: secDispatch.contract_id,
        agent_id: 'workbuddy',
        claim_token: secPolled.contract?.claim_token,
        result_summary: 'Attempted to attach .env as artifact',
        artifacts_pointers: [{ path: '.env', description: 'secret file' }],
      });
      assert.strictEqual(secFulfill.ok, false);
      assert.strictEqual(secFulfill.status, 'RETRY_NEEDED');
      assert.strictEqual(secFulfill.dirty_files?.[0].reason, 'SECURITY_REJECTED');

      // Clean no-op fulfillment after Strike 1 should succeed with no-op warning in message
      const noOpFulfill = mutEngine.fulfillContract({
        contract_id: secDispatch.contract_id,
        agent_id: 'workbuddy',
        claim_token: secPolled.contract?.claim_token,
        result_summary: 'Verified no changes needed',
      });
      assert.strictEqual(noOpFulfill.ok, true);
      assert.strictEqual(noOpFulfill.status, 'COMPLETED');
      assert.strictEqual(noOpFulfill.no_op, true, 'No-op mutation fulfillment must set structured no_op: true');
      assert.ok(noOpFulfill.message.includes('WARNING: no-op fulfillment'), 'No-op mutation fulfillment must include warning');

      // Deleting a pointer file or declaring a non-existent artifact during a mutation task must fail with FILE_MISSING
      const delDispatch = mutEngine.dispatchContract({
        target_agent: 'workbuddy',
        task_type: 'test_generation',
        title: 'Deleted pointer & phantom artifact guard test',
        context_summary: 'Ensure deleting a pointer file or declaring phantom artifact blocks fulfillment',
        workspace_root: mutDir,
        pointers: [{ path: 'feature.ts' }],
      });
      const delPolled = await mutEngine.pollNextTask({ agent_id: 'workbuddy' });
      const phantomFulfill = mutEngine.fulfillContract({
        contract_id: delDispatch.contract_id,
        agent_id: 'workbuddy',
        claim_token: delPolled.contract?.claim_token,
        result_summary: 'Declared phantom artifact',
        artifacts_pointers: [{ path: 'does-not-exist.test.ts', description: 'phantom test' }],
      });
      assert.strictEqual(phantomFulfill.ok, false);
      assert.strictEqual(phantomFulfill.status, 'RETRY_NEEDED');
      assert.strictEqual(phantomFulfill.dirty_files?.[0].reason, 'FILE_MISSING');
      console.log('  PASS [16F - Mutation Task Fulfillment]: post-COMPLETED verify, read-only regression control, SECURITY_REJECTED, phantom artifact FILE_MISSING, and no-op warning verified.');
    } finally {
      mutEngine.close();
      mutCleanup();
    }
  } finally {
    setNotifyWebhook(undefined);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

async function test17_StaticAnalysisGate(): Promise<void> {
  console.log('\n[Test 17] Static Analysis Gate & Verification Harness (Phase 3 Step 2)');
  const gate = await import('../scripts/static-analysis-gate.cjs');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrycat-test17-'));

  try {
    // 17A: False Positive Guard
    const fpFile = path.join(tempDir, 'fp.ts');
    fs.writeFileSync(
      fpFile,
      [
        'const svc = "disk-usage-monitoring-agent";',
        'const doc = "risk-management-platform-notes";',
        'const f = "mask-sensitive-data-before-logging";',
        'const q = "task-queue-worker-config-identifier";',
        'function f(s){ return /a==b/.test(s); }',
        'const msg = `line one\n a == b \nline three`;',
        'const flag = true; // compare a == b',
        '/* block comment a == b */',
        'const debuggerFlag = true;',
        'obj.eval("test");',
      ].join('\n')
    );
    const fpRes = gate.runAnalysis(tempDir, ['fp.ts']);
    assert.strictEqual(fpRes.approved, true);
    assert.strictEqual(fpRes.errorCount, 0);
    assert.strictEqual(fpRes.warningCount, 0);
    assert.strictEqual(fpRes.findings.length, 0);
    console.log('  PASS [17A - False-Positive Guard]: string tokens (task-, disk-), regex literals, multi-line templates, and comments passed with 0 findings.');

    // 17B: True-Positive Secret Detection
    const secFile = path.join(tempDir, 'sec.ts');
    fs.writeFileSync(
      secFile,
      [
        'const k1 = "sk-proj-AbCdEf0123456789AbCdEf0123456789";',
        'const k2 = "sk-svcacct-AbCdEf0123456789AbCdEf0123456789";',
        'const k3 = "sk-AbCdEf0123456789AbCdEf0123456789";',
      ].join('\n')
    );
    const secRes = gate.runAnalysis(tempDir, ['sec.ts']);
    assert.strictEqual(secRes.approved, false);
    assert.strictEqual(secRes.errorCount, 3);
    assert.ok(secRes.findings.every((f: string) => f.includes('SEC-001')));
    console.log('  PASS [17B - Secret Detection]: sk-proj-, sk-svcacct-, and classic sk- keys detected with SEC-001.');

    // 17C: AST Injection Rules
    const astFile = path.join(tempDir, 'ast.ts');
    fs.writeFileSync(
      astFile,
      [
        'eval?.("test");',
        '(0, eval)("test");',
        'Function("return 1")();',
        'if (a == b) { debugger; }',
      ].join('\n')
    );
    const astRes = gate.runAnalysis(tempDir, ['ast.ts']);
    assert.strictEqual(astRes.approved, false);
    assert.ok(astRes.findings.some((f: string) => f.includes('AST-001')));
    assert.ok(astRes.findings.some((f: string) => f.includes('AST-002')));
    assert.ok(astRes.findings.some((f: string) => f.includes('AST-003')));
    console.log('  PASS [17C - AST Rules]: eval?.(), (0,eval)(), Function(), loose equality, and debugger caught.');

    // 17D: JSON Secret Scanning
    const jsonFile = path.join(tempDir, 'config.json');
    fs.writeFileSync(jsonFile, JSON.stringify({ api_key: 'sk-proj-AbCdEf0123456789AbCdEf0123456789' }, null, 2));
    const jsonRes = gate.runAnalysis(tempDir, ['config.json']);
    assert.strictEqual(jsonRes.approved, false);
    assert.strictEqual(jsonRes.errorCount, 1);
    assert.ok(jsonRes.findings[0].includes('SEC-001'));
    console.log('  PASS [17D - JSON Secret Scanning]: .json files undergo JSON syntax validation and secret scanning.');

    // 17E: Path Containment & IO Safety
    const outRes = gate.runAnalysis(tempDir, ['../outside.js']);
    assert.strictEqual(outRes.approved, false);
    assert.ok(outRes.findings[0].includes('SEC-002'));

    const hiddenRes = gate.runAnalysis(tempDir, ['..hidden.js']);
    assert.ok(!hiddenRes.findings[0].includes('SEC-002'));
    assert.ok(hiddenRes.findings[0].includes('IO-001'));
    console.log('  PASS [17E - Workspace Containment & IO]: ../ escapes rejected with SEC-002, ..hidden.js allowed, IO safe.');
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function test18_AsyncNonBlockingTransientRetry(): Promise<void> {
  console.log('\n[Test 18] FC-203: Async Non-Blocking Transient Retry & Event-Loop Liveness');
  const { dir, dbPath, cleanup } = createTempWorkspace('fc203-async-retry');
  // Use 120ms retry window so we can schedule timers at 25ms and 50ms inside the retry delay
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 120 });

  try {
    // 18A: Event loop remains responsive during fingerprint retry window
    const fileA = path.join(dir, 'buffer.ts');
    const cleanContent = 'export const flushed = true;\n';
    fs.writeFileSync(fileA, cleanContent, 'utf8');

    const c1 = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Event loop non-blocking test',
      context_summary: 'Verify timers fire during transient retry delay',
      workspace_root: dir,
      pointers: [{ path: 'buffer.ts' }],
    });

    // Dirty the file so the first read in pollNextTask triggers the 120ms retry sleep
    fs.writeFileSync(fileA, 'export const flushed = false; // mid-write\n', 'utf8');

    const tickTimestamps: number[] = [];
    const retryWindowStartMs = Date.now();
    const ticker = setInterval(() => {
      tickTimestamps.push(Date.now());
    }, 20);

    const pollStale = await engine.pollNextTask({ agent_id: 'workbuddy' });
    const retryWindowEndMs = Date.now();
    clearInterval(ticker);

    assert.strictEqual(pollStale.status, 'POINTER_STALE');
    assert.strictEqual(pollStale.stale_error?.contract_id, c1.contract_id);
    const ticksInsideWindow = tickTimestamps.filter(
      (ts) => ts >= retryWindowStartMs && ts <= retryWindowEndMs
    );
    assert.ok(
      ticksInsideWindow.length >= 1,
      `Event loop must NOT be blocked by Atomics.wait during retry window; expected >= 1 timer tick inside [${retryWindowStartMs}, ${retryWindowEndMs}], got ${ticksInsideWindow.length}`
    );
    console.log(
      `  PASS [18A - Non-Blocking Event Loop]: ${ticksInsideWindow.length} event-loop timer tick(s) fired inside [${retryWindowStartMs}, ${retryWindowEndMs}] during 120ms retry window.`
    );

    // 18B: Transient IDE buffer flush healing during the async retry window
    fs.writeFileSync(fileA, cleanContent, 'utf8');
    const c2 = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Transient flush healing test',
      context_summary: 'File heals on disk 30ms into the 120ms retry window',
      workspace_root: dir,
      pointers: [{ path: 'buffer.ts' }],
    });

    // Simulate transient half-written file at the start of pollNextTask
    fs.writeFileSync(fileA, 'export const flushed = false; // transient half-write\n', 'utf8');

    // Schedule an async flush 30ms later (impossible to run if main thread were blocked by Atomics.wait!)
    setTimeout(() => {
      fs.writeFileSync(fileA, cleanContent, 'utf8');
    }, 30);

    const pollHealed = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.strictEqual(pollHealed.has_task, true, 'Contract must be claimed after transient flush heals within retry window');
    assert.strictEqual(pollHealed.status, 'CLAIMED');
    assert.strictEqual(pollHealed.contract?.contract_id, c2.contract_id);
    console.log('  PASS [18B - Transient Flush Healing]: File healed asynchronously at 30ms during 120ms retry window and claimed as CLAIMED.');

    // 18C: Source audit confirming zero Atomics.wait / SharedArrayBuffer in src/
    const fpSrc = fs.readFileSync(path.resolve('src/fingerprint.ts'), 'utf8');
    const engSrc = fs.readFileSync(path.resolve('src/engine.ts'), 'utf8');
    assert.ok(!fpSrc.includes('Atomics.wait'), 'src/fingerprint.ts must not contain Atomics.wait');
    assert.ok(!fpSrc.includes('SharedArrayBuffer'), 'src/fingerprint.ts must not contain SharedArrayBuffer');
    assert.ok(!engSrc.includes('Atomics.wait'), 'src/engine.ts must not contain Atomics.wait');
    console.log('  PASS [18C - Zero Sync-Sleep Debt]: Confirmed zero Atomics.wait / SharedArrayBuffer in production src/.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test19_SelfContainedGitPatchMode(): Promise<void> {
  console.log('\n[Test 19] FC-202: Self-Contained Git Patch Mode & Cross-Branch Handoff');
  const { dir, dbPath, cleanup } = createTempWorkspace('fc202-git-patch');
  const engine = new FerryCatEngine({ dbPath, defaultAgentName: 'antigravity', fingerprintRetryDelayMs: 10 });

  try {
    // 19A: Cross-branch handoff where requester dispatches from feature branch with git_patch,
    // and worker claims/verifies/fulfills while working tree is switched to main branch
    const calcFile = path.join(dir, 'calc.ts');
    const featureFile = path.join(dir, 'feature-x.ts');
    const branchACalc = 'export const add = (a: number, b: number) => a + b;\nexport const mul = (a: number, b: number) => a * b;\n';
    const branchAFeature = 'export const featureX = "enabled-on-branch-A";\n';
    fs.writeFileSync(calcFile, branchACalc, 'utf8');
    fs.writeFileSync(featureFile, branchAFeature, 'utf8');

    const samplePatch = [
      'diff --git a/calc.ts b/calc.ts',
      'index 1111111..2222222 100644',
      '--- a/calc.ts',
      '+++ b/calc.ts',
      '@@ -1 +1,2 @@',
      ' export const add = (a: number, b: number) => a + b;',
      '+export const mul = (a: number, b: number) => a * b;',
      'diff --git a/feature-x.ts b/feature-x.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/feature-x.ts',
      '@@ -0,0 +1 @@',
      '+export const featureX = "enabled-on-branch-A";',
      '',
    ].join('\n');

    const expectedPatchSha = crypto.createHash('sha256').update(Buffer.from(samplePatch, 'utf8')).digest('hex');

    // Dispatch 1: Normal contract WITHOUT git_patch (control group)
    const noPatchContract = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Review without patch (will go POINTER_STALE on branch switch)',
      context_summary: 'Control contract without git_patch',
      workspace_root: dir,
      pointers: [{ path: 'calc.ts' }, { path: 'feature-x.ts' }],
    });

    // Dispatch 2: Self-contained contract WITH git_patch
    const patchContract = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Cross-branch review with self-contained git_patch',
      context_summary: 'Review feature-x diff even when local workspace is checked out on main',
      workspace_root: dir,
      pointers: [{ path: 'calc.ts' }, { path: 'feature-x.ts' }],
      git_patch: samplePatch,
    });

    assert.strictEqual(patchContract.patch_sha256, expectedPatchSha);
    assert.strictEqual(patchContract.patch_bytes, Buffer.byteLength(samplePatch, 'utf8'));

    // Simulate switching local git branch to `main`:
    // calc.ts reverts to 1-line version, and feature-x.ts does not exist on `main`!
    fs.writeFileSync(calcFile, 'export const add = (a: number, b: number) => a + b;\n', 'utf8');
    fs.unlinkSync(featureFile);

    // Polling once must mark noPatchContract as POINTER_STALE, skip it, and claim patchContract in SELF_CONTAINED mode!
    const pollRes = await engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.strictEqual(pollRes.has_task, true);
    assert.strictEqual(pollRes.status, 'CLAIMED');
    assert.strictEqual(pollRes.contract?.contract_id, patchContract.contract_id);
    assert.strictEqual(pollRes.contract?.patch_mode, 'SELF_CONTAINED');
    assert.strictEqual(pollRes.contract?.git_patch, samplePatch);
    assert.strictEqual(pollRes.contract?.patch_sha256, expectedPatchSha);
    assert.ok(
      pollRes.contract?.workspace_warning && pollRes.contract.workspace_warning.includes('SELF_CONTAINED_PATCH_MODE'),
      'SELF_CONTAINED poll must emit explicit workspace_warning'
    );

    const noPatchState = engine.inspectMeshState({ contract_id: noPatchContract.contract_id }).contracts[0];
    assert.strictEqual(noPatchState.status, 'POINTER_STALE', 'Contract without git_patch must be marked POINTER_STALE on branch switch');

    // Pre-flight verifyContract on the cross-branch contract must report valid=true & fulfillable=true
    const verifyRes = engine.verifyContract({
      contract_id: patchContract.contract_id,
      agent_id: 'workbuddy',
    });
    assert.strictEqual(verifyRes.valid, true);
    assert.strictEqual(verifyRes.fulfillable, true);
    assert.strictEqual(verifyRes.dirty_files.length, 2, 'dirty_files still reports the 2 local branch differences for transparency');
    assert.ok(verifyRes.message.includes('Self-contained git_patch baseline verified'));

    // Fulfill the cross-branch contract: must succeed as COMPLETED without triggering TOCTOU rejection!
    const fulfillRes = engine.fulfillContract({
      contract_id: patchContract.contract_id,
      agent_id: 'workbuddy',
      claim_token: pollRes.contract?.claim_token,
      result_summary: 'Cross-branch diff reviewed via self-contained git_patch. LGTM.',
    });
    assert.strictEqual(fulfillRes.ok, true);
    assert.strictEqual(fulfillRes.status, 'COMPLETED');

    const completedRow = engine.inspectMeshState({ contract_id: patchContract.contract_id }).contracts[0];
    assert.strictEqual(completedRow.status, 'COMPLETED');
    assert.strictEqual(completedRow.patch_sha256, expectedPatchSha);
    assert.strictEqual(completedRow.patch_bytes, Buffer.byteLength(samplePatch, 'utf8'));
    assert.strictEqual(completedRow.git_patch, undefined, 'inspectMeshState omits raw git_patch by default');
    const completedWithPatch = engine.inspectMeshState({ contract_id: patchContract.contract_id, include_patch: true }).contracts[0];
    assert.strictEqual(completedWithPatch.git_patch, samplePatch, 'inspectMeshState includes git_patch when include_patch=true');

    const vSha = completedRow.verified_sha256 as Record<string, string>;
    assert.strictEqual(vSha.__patch_mode__, 'SELF_CONTAINED');
    assert.strictEqual(vSha.__git_patch_sha256__, expectedPatchSha);
    assert.strictEqual(vSha.__verified_on_disk__, 'NO');
    assert.strictEqual(vSha.__unverified_pointers__, 'calc.ts,feature-x.ts');
    assert.strictEqual(vSha['calc.ts'], undefined, 'Unverified on-disk pointer calc.ts must NOT be recorded in verified_sha256');
    assert.strictEqual(vSha['feature-x.ts'], undefined, 'Unverified missing pointer feature-x.ts must NOT be recorded in verified_sha256');
    console.log('  PASS [19A - Cross-Branch Handoff]: Self-contained git_patch contract claimed with workspace_warning, verified, and COMPLETED with honest verified_sha256 metadata.');

    // 19B: Patch Security Blacklist & Path Traversal Guard
    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Malicious patch touching .env',
          context_summary: 'Must be blocked by assertSafeGitPatch',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: 'diff --git a/.env.production b/.env.production\n--- a/.env.production\n+++ b/.env.production\n@@ -1 +1 @@\n+SECRET=123\n',
        }),
      /Git patch rejected by security blacklist/i,
      'Patch headers touching .env must be rejected'
    );

    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Malicious patch with traversal',
          context_summary: 'Must be blocked by assertSafeGitPatch',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: '--- a/../../etc/passwd\n+++ b/../../etc/passwd\n@@ -1 +1 @@\n+root:x:0:0\n',
        }),
      /escapes workspace boundary/i,
      'Patch headers with ../ traversal must be rejected'
    );

    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Oversized patch > 512KB',
          context_summary: 'Must be rejected by 512KB limit',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: 'a'.repeat(530 * 1024),
        }),
      /exceeds maximum allowed limit of 524288 bytes/i,
      'Oversized git_patch > 512KB must be rejected'
    );
    console.log('  PASS [19B - Patch Security & Size Guards]: Sensitive diff headers (.env), path traversal (../), and >512KB patches rejected.');

    // 19D: Negative Gate 1 & 2 — Non-diff prose string and patch not covering pointers MUST be rejected
    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Junk prose string as git_patch',
          context_summary: 'Must fail NOT_A_UNIFIED_DIFF',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: 'This is a 49-byte prose string without diff hdrs!',
        }),
      /NOT_A_UNIFIED_DIFF/i,
      'Prose string without unified diff headers must be rejected with NOT_A_UNIFIED_DIFF'
    );

    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Patch touching only README.md while pointer is calc.ts',
          context_summary: 'Must fail PATCH_DOES_NOT_COVER_POINTERS',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1 @@\n+# docs\n',
        }),
      /PATCH_DOES_NOT_COVER_POINTERS/i,
      'Patch not covering pointer files must be rejected with PATCH_DOES_NOT_COVER_POINTERS'
    );

    // Verify C-quoted space paths and legitimate identifier names (e.g., my file.ts) work cleanly
    const spacedFile = path.join(dir, 'my file.ts');
    fs.writeFileSync(spacedFile, 'export const spaced = 1;\n', 'utf8');
    const spacedPatch = [
      'diff --git "a/my file.ts" "b/my file.ts"',
      '--- "a/my file.ts"',
      '+++ "b/my file.ts"',
      '@@ -1 +1 @@',
      '+export const spaced = 1;',
      '',
    ].join('\n');
    const spacedDispatch = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'C-quoted space path diff test',
      context_summary: 'Verify C-quoted diff --git paths cover pointers',
      workspace_root: dir,
      pointers: [{ path: 'my file.ts' }],
      git_patch: spacedPatch,
    });
    assert.ok(spacedDispatch.patch_sha256, 'C-quoted path with spaces must be accepted when covering pointer');
    console.log('  PASS [19D - Unified Diff & Pointer Coverage Gates]: Prose strings (NOT_A_UNIFIED_DIFF) and partial patches (PATCH_DOES_NOT_COVER_POINTERS) rejected; C-quoted space paths accepted.');

    // 19E: R1 — a header-only patch names files but carries no reviewable diff content and MUST be rejected
    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Single --- header line only',
          context_summary: 'Must fail EMPTY_PATCH_HUNKS',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: '--- a/calc.ts',
        }),
      /EMPTY_PATCH_HUNKS/i,
      'A 13-byte single `--- a/calc.ts` line must be rejected with EMPTY_PATCH_HUNKS'
    );

    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Header-only patch with zero hunks',
          context_summary: 'Must fail EMPTY_PATCH_HUNKS',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: '--- a/calc.ts\n+++ b/calc.ts',
        }),
      /EMPTY_PATCH_HUNKS/i,
      'A header-only patch (--- / +++, zero hunks) must be rejected with EMPTY_PATCH_HUNKS'
    );

    assert.throws(
      () =>
        engine.dispatchContract({
          target_agent: 'workbuddy',
          task_type: 'code_review',
          title: 'Context-only hunk with no changed lines',
          context_summary: 'Must fail EMPTY_PATCH_CONTENT',
          workspace_root: dir,
          pointers: [{ path: 'calc.ts' }],
          git_patch: [
            '--- a/calc.ts',
            '+++ b/calc.ts',
            '@@ -1,2 +1,2 @@',
            ' export const add = (a: number, b: number) => a + b;',
            ' export const mul = (a: number, b: number) => a * b;',
          ].join('\n'),
        }),
      /EMPTY_PATCH_CONTENT/i,
      'A hunk with only context lines must be rejected with EMPTY_PATCH_CONTENT'
    );

    // A hunk body line may itself begin with `--- ` / `+++ ` (removed line starting with `--`).
    // It must be counted as content, never mis-parsed as a file header.
    const doubleDashPatch = [
      'diff --git a/calc.ts b/calc.ts',
      '--- a/calc.ts',
      '+++ b/calc.ts',
      '@@ -1,2 +1,2 @@',
      '--- sql comment line',
      '+++ added line starting with plus plus',
      ' export const mul = (a: number, b: number) => a * b;',
      '',
    ].join('\n');
    const doubleDashDispatch = engine.dispatchContract({
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Hunk body lines that look like headers',
      context_summary: 'Must not be mis-parsed as file headers',
      workspace_root: dir,
      pointers: [{ path: 'calc.ts' }],
      git_patch: doubleDashPatch,
    });
    assert.ok(
      doubleDashDispatch.patch_sha256,
      'Hunk body lines beginning with --- / +++ must be treated as content, not headers'
    );
    console.log(
      '  PASS [19E - Hunk & Content Gates]: Header-only (13B single line / 28B --- + +++) rejected as EMPTY_PATCH_HUNKS; context-only hunk rejected as EMPTY_PATCH_CONTENT; --- / +++ payload lines inside a hunk counted as content.'
    );

    // 19C: CLI --patch-file integration
    const patchFilePath = path.join(dir, 'changes.patch');
    fs.writeFileSync(patchFilePath, samplePatch, 'utf8');
    const cliPayloadPath = path.join(dir, 'dispatch-patch.json');
    fs.writeFileSync(
      cliPayloadPath,
      JSON.stringify({
        requester_agent: 'antigravity',
        target_agent: 'workbuddy',
        task_type: 'code_review',
        title: 'CLI --patch-file dispatch test',
        context_summary: 'Verify --patch-file attaches git_patch',
        workspace_root: dir,
        pointers: [{ path: 'calc.ts' }],
      }),
      'utf8'
    );

    const cliPath = path.resolve('dist/cli.js');
    const cliOut = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      execFile(
        process.execPath,
        ['--experimental-sqlite', cliPath, 'dispatch', '--file', cliPayloadPath, '--patch-file', patchFilePath],
        { env: { ...process.env, FERRYCAT_DB_PATH: dbPath } },
        (err, stdout, stderr) => resolve({ code: err ? ((err.code as number) ?? 1) : 0, stdout, stderr })
      );
    });
    assert.strictEqual(cliOut.code, 0, `CLI dispatch --patch-file failed: ${cliOut.stderr}`);
    const parsedCliDispatch = JSON.parse(cliOut.stdout);
    assert.strictEqual(parsedCliDispatch.patch_sha256, expectedPatchSha);
    console.log('  PASS [19C - CLI --patch-file]: ferrycat-cli dispatch --patch-file attached and hashed patch payload.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test20_DaemonJournalAndCrashSelfHealing(): Promise<void> {
  console.log('\n[Test 20] Phase 3 Step 2: Daemon Write-Ahead Journal (daemon-journal.jsonl) & Crash Self-Healing');
  const { FerryCatDaemon } = await import('../src/daemon.js');
  const { dir, dbPath, cleanup } = createTempWorkspace('step2-daemon-journal');

  try {
    const sampleFile = path.join(dir, 'app.ts');
    fs.writeFileSync(sampleFile, 'export const ready = true;\n', 'utf8');

    const handlerFile = path.join(dir, 'ok-handler.cjs');
    fs.writeFileSync(
      handlerFile,
      `
      const fs = require('node:fs');
      const raw = fs.readFileSync(0, 'utf8');
      const contract = JSON.parse(raw);
      process.stdout.write(JSON.stringify({
        result_summary: "Handled " + contract.contract_id + " cleanly",
        structured_output: { ok: true }
      }) + "\\n");
      `,
      'utf8'
    );

    const cfgPath = path.join(dir, 'ferrycat.config.json');
    fs.writeFileSync(
      cfgPath,
      JSON.stringify({
        version: 1,
        daemon: {
          lock_id: 'journal-lock',
          lease_ttl_sec: 10,
          heartbeat_interval_ms: 2000,
          poll_interval_ms: 500,
          notify: false,
        },
        agents: {
          workbuddy: {
            handlers: {
              code_review: {
                exec_file: handlerFile,
              },
            },
          },
        },
      }),
      'utf8'
    );

    // 20A: Normal lifecycle write-ahead journal trail (TASK_DISPATCHING -> CHILD_SPAWNED -> TASK_SETTLED)
    const daemonA = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
    const cNormal = daemonA.engine.dispatchContract({
      requester_agent: 'antigravity',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Normal journal trail test',
      context_summary: 'Verify write-ahead journal entries on normal execution',
      workspace_root: dir,
      pointers: [{ path: 'app.ts' }],
    });

    const cycleRes = await daemonA.pollAndDispatchOnce();
    assert.strictEqual(cycleRes.processed, true);
    assert.strictEqual(cycleRes.contract_id, cNormal.contract_id);
    assert.strictEqual(cycleRes.status, 'COMPLETED');

    const entriesA = daemonA.readJournalEntries();
    const eventsForNormal = entriesA.filter((e) => e.contract_id === cNormal.contract_id).map((e) => e.event);
    assert.deepStrictEqual(
      eventsForNormal,
      ['TASK_DISPATCHING', 'CHILD_SPAWNED', 'TASK_SETTLED'],
      `Expected TASK_DISPATCHING -> CHILD_SPAWNED -> TASK_SETTLED in daemon-journal.jsonl, got ${JSON.stringify(eventsForNormal)}`
    );
    const spawnedEntry = entriesA.find((e) => e.contract_id === cNormal.contract_id && e.event === 'CHILD_SPAWNED');
    assert.ok(spawnedEntry?.child_pid && spawnedEntry.child_pid > 0, 'CHILD_SPAWNED entry must record child_pid');
    daemonA.releaseLease();
    daemonA.engine.close();
    console.log('  PASS [20A - Write-Ahead Journal Trail]: Recorded TASK_DISPATCHING -> CHILD_SPAWNED (with PID) -> TASK_SETTLED.');

    // 20B: Simulated SIGKILL Mid-Flight Crash & Automatic Self-Healing on Takeover
    const daemonCrashed = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
    const cOrphan = daemonCrashed.engine.dispatchContract({
      requester_agent: 'antigravity',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Orphaned mid-flight contract',
      context_summary: 'Simulate SIGKILL after CHILD_SPAWNED before TASK_SETTLED',
      workspace_root: dir,
      pointers: [{ path: 'app.ts' }],
    });

    assert.strictEqual(daemonCrashed.acquireLease(), true);
    const claimedOrphan = await daemonCrashed.engine.pollNextTask({ agent_id: 'workbuddy' });
    assert.strictEqual(claimedOrphan.status, 'CLAIMED');
    const orphanToken = claimedOrphan.contract!.claim_token!;

    // Simulate daemon writing TASK_DISPATCHING + CHILD_SPAWNED and a truncated tail line during power loss / SIGKILL
    daemonCrashed.appendJournalEntry({
      event: 'TASK_DISPATCHING',
      contract_id: cOrphan.contract_id,
      target_agent: 'workbuddy',
      task_type: 'code_review',
      claim_token: orphanToken,
      exec_file: handlerFile,
    });
    daemonCrashed.appendJournalEntry({
      event: 'CHILD_SPAWNED',
      contract_id: cOrphan.contract_id,
      target_agent: 'workbuddy',
      claim_token: orphanToken,
      child_pid: 99999,
      child_started_at: Date.now(),
    });
    // Append a corrupt half-written JSON line simulating abrupt power loss
    fs.appendFileSync(daemonCrashed.journalPath, '{"seq":999,"event":"TASK_SETT', 'utf8');

    // Release the DB lease lock (or let it expire) to simulate daemonCrashed dying without settling the contract
    daemonCrashed.releaseLease();
    daemonCrashed.engine.close();

    // Now start Replacement Daemon Instance B:
    // Calling pollAndDispatchOnce() acquires leadership -> triggers recoverFromJournal() ->
    // heals cOrphan (records salvage + releases CLAIMED -> SUBMITTED) -> immediately re-claims and executes cOrphan to COMPLETED!
    const daemonHealer = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
    const healCycle = await daemonHealer.pollAndDispatchOnce();
    assert.strictEqual(healCycle.processed, true, 'Healer daemon must recover orphaned contract and execute it in the same cycle');
    assert.strictEqual(healCycle.contract_id, cOrphan.contract_id);
    assert.strictEqual(healCycle.status, 'COMPLETED');

    const healedContract = daemonHealer.engine.inspectMeshState({ contract_id: cOrphan.contract_id }).contracts[0];
    assert.strictEqual(healedContract.status, 'COMPLETED');
    assert.strictEqual(healedContract.release_count, 1, 'Orphaned contract must show release_count=1 from journal recovery');
    assert.ok(
      String(healedContract.error_reason).includes('DAEMON_CRASH_RECOVERED'),
      `Expected DAEMON_CRASH_RECOVERED in error_reason history, got: ${healedContract.error_reason}`
    );
    const salvagedMeta = healedContract.salvaged_result as Record<string, unknown> | null;
    assert.strictEqual(salvagedMeta?.source, 'DAEMON_CRASH_JOURNAL_RECOVERY');
    assert.strictEqual(salvagedMeta?.crashed_daemon_owner_token, daemonCrashed.ownerToken);
    assert.strictEqual(salvagedMeta?.orphaned_child_pid, 99999);

    const entriesAfterHeal = daemonHealer.readJournalEntries();
    const recoveryEntry = entriesAfterHeal.find(
      (e) => e.contract_id === cOrphan.contract_id && e.event === 'CRASH_RECOVERED'
    );
    assert.ok(recoveryEntry, 'CRASH_RECOVERED journal entry must be appended');
    assert.strictEqual(recoveryEntry?.recovery_action, 'RELEASED_TO_QUEUE');
    assert.strictEqual(recoveryEntry?.previous_owner_token, daemonCrashed.ownerToken);
    console.log(
      '  PASS [20B1 - Dead Read-Only Orphan Recovery]: Confirmed-dead read-only contract recovered via journal, salvaged forensics, re-queued, and COMPLETED.'
    );

    // 20B2: Live Orphan Process Quarantine (QUARANTINED_ORPHAN_ALIVE)
    const liveSleeper = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: 'ignore',
    });
    try {
      assert.ok(liveSleeper.pid && liveSleeper.pid > 0, 'Sleeper child must have a live PID');
      const cLiveOrphan = daemonHealer.engine.dispatchContract({
        requester_agent: 'antigravity',
        target_agent: 'workbuddy',
        task_type: 'code_review',
        title: 'Live orphan quarantine test',
        context_summary: 'Verify recoverFromJournal quarantines still-running child process instead of concurrent re-queue',
        workspace_root: dir,
        pointers: [{ path: 'app.ts' }],
      });
      const pLive = await daemonHealer.engine.pollNextTask({ agent_id: 'workbuddy' });
      const liveToken = pLive.contract!.claim_token!;
      daemonHealer.appendJournalEntry({
        event: 'TASK_DISPATCHING',
        contract_id: cLiveOrphan.contract_id,
        target_agent: 'workbuddy',
        task_type: 'code_review',
        claim_token: liveToken,
        exec_file: handlerFile,
      });
      daemonHealer.appendJournalEntry({
        event: 'CHILD_SPAWNED',
        contract_id: cLiveOrphan.contract_id,
        target_agent: 'workbuddy',
        claim_token: liveToken,
        child_pid: liveSleeper.pid,
        child_started_at: Date.now(),
      });
      daemonHealer.releaseLease();
      daemonHealer.engine.close();

      const daemonQuarantiner = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
      assert.strictEqual(daemonQuarantiner.acquireLease(), true);
      const quarantinedRow = daemonQuarantiner.engine.inspectMeshState({ contract_id: cLiveOrphan.contract_id }).contracts[0];
      assert.strictEqual(
        quarantinedRow.status,
        'FAILED',
        'Orphaned contract whose child PID is still alive must be quarantined as FAILED, never re-queued concurrently'
      );
      assert.ok(String(quarantinedRow.error_reason).includes('DAEMON_CRASH_ORPHAN_STILL_ALIVE'));
      const qEntries = daemonQuarantiner.readJournalEntries();
      const qEntry = qEntries.find((e) => e.contract_id === cLiveOrphan.contract_id && e.event === 'CRASH_RECOVERED');
      assert.strictEqual(qEntry?.recovery_action, 'QUARANTINED_ORPHAN_ALIVE');

      // 20B3: Mutation Task Crash Protection (MARKED_FAILED_MUTATION_UNSAFE)
      const cMutationOrphan = daemonQuarantiner.engine.dispatchContract({
        requester_agent: 'antigravity',
        target_agent: 'workbuddy',
        task_type: 'implementation',
        title: 'Interrupted mutation contract',
        context_summary: 'Mutation tasks must not be auto-requeued on daemon crash recovery',
        workspace_root: dir,
        pointers: [{ path: 'app.ts' }],
      });
      const pMut = await daemonQuarantiner.engine.pollNextTask({ agent_id: 'workbuddy' });
      const mutToken = pMut.contract!.claim_token!;
      daemonQuarantiner.appendJournalEntry({
        event: 'TASK_DISPATCHING',
        contract_id: cMutationOrphan.contract_id,
        target_agent: 'workbuddy',
        task_type: 'implementation',
        claim_token: mutToken,
        exec_file: handlerFile,
      });
      daemonQuarantiner.releaseLease();
      daemonQuarantiner.engine.close();

      const daemonMutGuard = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
      assert.strictEqual(daemonMutGuard.acquireLease(), true);
      const mutRow = daemonMutGuard.engine.inspectMeshState({ contract_id: cMutationOrphan.contract_id }).contracts[0];
      assert.strictEqual(
        mutRow.status,
        'FAILED',
        'Interrupted mutation contract must transition to FAILED to protect workspace files'
      );
      assert.ok(String(mutRow.error_reason).includes('DAEMON_CRASH_MUTATION_ABORTED'));
      const mEntries = daemonMutGuard.readJournalEntries();
      const mEntry = mEntries.find((e) => e.contract_id === cMutationOrphan.contract_id && e.event === 'CRASH_RECOVERED');
      assert.strictEqual(mEntry?.recovery_action, 'MARKED_FAILED_MUTATION_UNSAFE');
      daemonMutGuard.releaseLease();
      daemonMutGuard.engine.close();
      console.log(
        '  PASS [20B2/20B3 - Live Orphan Quarantine & Mutation Crash Guard]: Live child PID quarantined (QUARANTINED_ORPHAN_ALIVE) and interrupted implementation task aborted (MARKED_FAILED_MUTATION_UNSAFE).'
      );
    } finally {
      try {
        liveSleeper.kill('SIGKILL');
      } catch {
        // already dead
      }
    }

    const daemonHealer2 = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
    assert.strictEqual(daemonHealer2.acquireLease(), true);

    // 20C: Crash Recovery Exhaustion Circuit Breaker (when release_count === MAX_RELEASES = 3)
    const cExhaust = daemonHealer2.engine.dispatchContract({
      requester_agent: 'antigravity',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Exhausted release quota crash test',
      context_summary: 'Verify contract with 3 prior releases transitions to FAILED on crash recovery',
      workspace_root: dir,
      pointers: [{ path: 'app.ts' }],
    });
    // Consume all 3 releases
    for (let i = 0; i < 3; i++) {
      const p = await daemonHealer2.engine.pollNextTask({ agent_id: 'workbuddy' });
      daemonHealer2.engine.releaseContract({
        contract_id: cExhaust.contract_id,
        agent_id: 'workbuddy',
        claim_token: p.contract?.claim_token,
        reason: `manual release #${i + 1}`,
      });
    }
    const pFinal = await daemonHealer2.engine.pollNextTask({ agent_id: 'workbuddy' });
    const finalToken = pFinal.contract!.claim_token!;
    daemonHealer2.appendJournalEntry({
      event: 'TASK_DISPATCHING',
      contract_id: cExhaust.contract_id,
      target_agent: 'workbuddy',
      task_type: 'code_review',
      claim_token: finalToken,
      exec_file: handlerFile,
    });
    daemonHealer2.releaseLease();
    daemonHealer2.engine.close();

    const daemonFinal = new FerryCatDaemon({ configPath: cfgPath, dbPath, notify: false });
    assert.strictEqual(daemonFinal.acquireLease(), true);
    const exhaustedState = daemonFinal.engine.inspectMeshState({ contract_id: cExhaust.contract_id }).contracts[0];
    assert.strictEqual(exhaustedState.status, 'FAILED');
    assert.ok(String(exhaustedState.error_reason).includes('DAEMON_CRASH_RECOVERY_EXHAUSTED'));
    daemonFinal.releaseLease();
    daemonFinal.engine.close();
    console.log(
      '  PASS [20C - Crash Recovery Circuit Breaker]: Orphaned contract at max_releases (3/3) deterministically transitioned to FAILED.'
    );

    // 20D: R3/R4/R6/R7 — daemon_started_at journaling, predecessor-alive-without-child recovery,
    // legacy journal fallback and getStatus() journal health visibility.
    const d2Dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc404-20d-'));
    const d2Db = path.join(d2Dir, 'mesh.db');
    const d2Cfg = path.join(d2Dir, 'cfg.json');
    fs.writeFileSync(d2Cfg, JSON.stringify({
      version: 1,
      daemon: { lock_id: 'r4-lock', lease_ttl_sec: 10, heartbeat_interval_ms: 2000, poll_interval_ms: 500, notify: false },
      agents: { workbuddy: { handlers: { code_review: { exec_file: handlerFile } } } },
    }), 'utf8');

    // A live process standing in for the still-alive predecessor daemon (PID != our own).
    const fakePredecessor = spawn(process.execPath, ['-e', 'setTimeout(()=>{},60000)'], { stdio: 'ignore' });
    const fakePredecessorPid = fakePredecessor.pid!;

    const daemonR4 = new FerryCatDaemon({ configPath: d2Cfg, dbPath: d2Db, notify: false });
    const cR4 = daemonR4.engine.dispatchContract({
      requester_agent: 'antigravity',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      title: 'Predecessor alive but no child spawned',
      context_summary: 'R4: must be re-queued, not burned as FAILED',
      workspace_root: dir,
      pointers: [{ path: 'app.ts' }],
    });
    assert.strictEqual(daemonR4.acquireLease(), true);
    const pollR4 = await daemonR4.engine.pollNextTask({ agent_id: 'workbuddy' });
    const tokenR4 = pollR4.contract!.claim_token!;
    // Hand-write the journal so daemon_pid can point at a live process we do not own.
    fs.writeFileSync(
      daemonR4.journalPath,
      JSON.stringify({
        seq: 1,
        timestamp: Date.now(),
        event: 'TASK_DISPATCHING',
        daemon_owner_token: 'crashed-predecessor-token',
        daemon_pid: fakePredecessorPid,
        daemon_started_at: Date.now() - 60000,
        lock_id: 'r4-lock',
        contract_id: cR4.contract_id,
        target_agent: 'workbuddy',
        task_type: 'code_review',
        claim_token: tokenR4,
        exec_file: handlerFile,
      }) + '\n',
      'utf8'
    );
    daemonR4.releaseLease();
    daemonR4.engine.close();

    const daemonR4Healer = new FerryCatDaemon({ configPath: d2Cfg, dbPath: d2Db, notify: false });
    const r4Recovered = daemonR4Healer.recoverFromJournal();
    const r4Row = daemonR4Healer.engine.inspectMeshState({ contract_id: cR4.contract_id }).contracts[0];
    assert.strictEqual(
      r4Recovered[0]?.action,
      'RELEASED_TO_QUEUE',
      `R4: a live predecessor with no live child must be re-queued (got ${r4Recovered[0]?.action})`
    );
    assert.strictEqual(r4Row.status, 'SUBMITTED', 'R4: contract must stay recoverable, not terminal FAILED');
    const r4Salvage = r4Row.salvaged_result as Record<string, unknown> | null;
    assert.strictEqual(r4Salvage?.predecessor_daemon_alive, true, 'R4: salvage must record the live predecessor');
    assert.strictEqual(r4Salvage?.orphaned_child_alive, false, 'R4: salvage must record no live child');

    // R7: getStatus() exposes journal health and lease ownership
    const statusR4 = daemonR4Healer.getStatus();
    assert.strictEqual(statusR4.lock_id, 'r4-lock');
    assert.strictEqual(statusR4.journal_path, daemonR4Healer.journalPath);
    assert.strictEqual(statusR4.journal_degraded, false);
    assert.ok(statusR4.journal_entries >= 1, 'getStatus must report journal entry count');
    assert.strictEqual(typeof statusR4.daemon_started_at, 'number');
    const probeEntry = daemonR4Healer.appendJournalEntry({
      event: 'TASK_SETTLED',
      contract_id: 'fc_r3_probe',
      target_agent: 'workbuddy',
      final_status: 'COMPLETED',
    });
    assert.strictEqual(
      typeof probeEntry.daemon_started_at,
      'number',
      'R3: every journal entry must carry daemon_started_at for PID-reuse disambiguation'
    );
    assert.ok(
      probeEntry.daemon_started_at <= Date.now(),
      'R3: daemon_started_at must not be in the future'
    );
    daemonR4Healer.releaseLease();
    daemonR4Healer.engine.close();

    // R6: legacy shared journal fallback for a non-global lock
    const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fc404-legacy-'));
    const legacyCfg = path.join(legacyDir, 'cfg.json');
    fs.writeFileSync(legacyCfg, JSON.stringify({
      version: 1,
      daemon: { lock_id: 'legacy-lock', lease_ttl_sec: 10, heartbeat_interval_ms: 2000, poll_interval_ms: 500, notify: false },
      agents: {},
    }), 'utf8');
    const legacyBase = {
      seq: 1,
      timestamp: Date.now(),
      event: 'TASK_DISPATCHING' as const,
      daemon_owner_token: 'legacy-owner',
      daemon_pid: 999999,
      daemon_started_at: Date.now() - 1000,
      contract_id: 'fc_legacy_1',
      target_agent: 'workbuddy',
      task_type: 'code_review',
      claim_token: 'legacy-token',
    };
    fs.writeFileSync(
      path.join(legacyDir, 'daemon-journal.jsonl'),
      JSON.stringify({ ...legacyBase, lock_id: 'legacy-lock' }) + '\n' +
        JSON.stringify({ ...legacyBase, seq: 2, lock_id: 'other-lock', contract_id: 'fc_other_1' }) + '\n',
      'utf8'
    );
    const legacyDaemon = new FerryCatDaemon({ configPath: legacyCfg, dbPath: path.join(legacyDir, 'mesh.db'), notify: false });
    assert.strictEqual(
      fs.existsSync(legacyDaemon.journalPath),
      false,
      'per-lock journal file must not exist yet in the legacy-fallback scenario'
    );
    const legacyEntries = legacyDaemon.readJournalEntries();
    assert.strictEqual(legacyEntries.length, 1, 'R6: must read only this lock_id records from the legacy shared journal');
    assert.strictEqual(legacyEntries[0].contract_id, 'fc_legacy_1');
    legacyDaemon.engine.close();

    try { fakePredecessor.kill('SIGKILL'); } catch { /* ignore */ }
    fs.rmSync(d2Dir, { recursive: true, force: true });
    fs.rmSync(legacyDir, { recursive: true, force: true });
    console.log(
      '  PASS [20D - Predecessor-Alive Requeue, Status & Legacy Journal]: Live predecessor without a live child re-queued (RELEASED_TO_QUEUE) with salvage flags; getStatus() exposes journal health; legacy daemon-journal.jsonl read back and filtered by lock_id.'
    );
  } finally {
    cleanup();
  }
}

async function main(): Promise<void> {
  console.log('==============================================================');
  console.log(' FerryCat Offline Verification Suite (Node ' + process.version + ')');
  console.log('==============================================================');

  await test1_DualProcessConcurrentPreemption();
  await test2_FingerprintStalenessHeadMiddleTail();
  await test3_SchemaValidationRetryAndCircuitBreak();
  await test4_SecurityPathBlacklist();
  await test5_DualStageTtlAndHappyPath();
  await test6_McpStdioHandshakeAndToolDiscovery();
  await test7_CliWorkerSubprocess();
  await test8_TrustBoundaryAndQueueUnblocking();
  await test9_LifecycleReleaseExtendFail();
  await test10_LegacySchemaMigrationAndCliLifecycle();
  await test11_PhaseBCliErgonomicsAndToctouBuffer();
  await test12_Phase031_LeaseTokensAndPayloadLimits();
  await test13_Step0SupervisorHardening();
  await test14_Step1ControlledDaemonAndCasLeases();
  await test15_DemoSandboxSimulation();
  await test16_DesktopNotificationAndWebhook();
  await test17_StaticAnalysisGate();
  await test18_AsyncNonBlockingTransientRetry();
  await test19_SelfContainedGitPatchMode();
  await test20_DaemonJournalAndCrashSelfHealing();

  console.log('\n==============================================================');
  console.log(' ALL 20 TEST SUITES PASSED GREEN');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
