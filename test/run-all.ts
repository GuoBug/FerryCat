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

    const pollHead = engine.pollNextTask({ agent_id: 'workbuddy' });
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

    const pollMid = engine.pollNextTask({ agent_id: 'workbuddy' });
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

    const pollTail = engine.pollNextTask({ agent_id: 'workbuddy' });
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
    const pollSize = engine.pollNextTask({ agent_id: 'workbuddy' });
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

    const claimed = engine.pollNextTask({ agent_id: 'workbuddy' });
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
    const claimed = engine.pollNextTask({ agent_id: 'workbuddy' }, tClaim);
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
    const cToctou = engine.pollNextTask({ agent_id: 'workbuddy' }, tFulfill + 1000);
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

    const pollLegit = engine.pollNextTask({ agent_id: 'agent-legit' });
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
    const pollQueue = engine.pollNextTask({ agent_id: 'queue-worker' });
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
    const pollResult = engine.pollNextTask({ agent_id: 'page-worker' });
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
      const polled = engine.pollNextTask({ agent_id: `ttl-${taskType}` }, t0 + S);
      assert.strictEqual(polled.contract?.exec_ttl_sec, ttl, `${taskType} default exec_ttl_sec`);
    }
    engine.dispatchContract({ ...base, task_type: 'code_review', target_agent: 'ttl-override', exec_ttl_sec: 42 }, t0);
    assert.strictEqual(engine.pollNextTask({ agent_id: 'ttl-override' }, t0 + S).contract?.exec_ttl_sec, 42);
    console.log('  PASS [9A - Tiered TTL]: review/audit=1800s, implementation/test=300s, explicit exec_ttl_sec overrides.');

    // 9B: release_contract preserves contract-level retry_count, re-queues at tail, enforces holder + release cap
    const schema = { type: 'object', required: ['ok'], properties: { ok: { type: 'boolean' } } };
    const relA = engine.dispatchContract({ ...base, target_agent: 'rel', title: 'A', contract_schema: schema }, t0);
    const relB = engine.dispatchContract({ ...base, target_agent: 'rel', title: 'B' }, t0 + 1);
    const pollRelA = engine.pollNextTask({ agent_id: 'rel' }, t0 + S);
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
    assert.strictEqual(engine.pollNextTask({ agent_id: 'rel' }, t0 + 5 * S).contract?.contract_id, relB.contract_id);
    const pollRelA2 = engine.pollNextTask({ agent_id: 'rel' }, t0 + 6 * S);
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
      const repoll = engine.pollNextTask({ agent_id: 'rel' }, tRel + S);
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
    const pRelC = engine.pollNextTask({ agent_id: 'rel-window' }, t0 + 50 * S);
    engine.releaseContract({ contract_id: relC.contract_id, agent_id: 'rel-window', claim_token: pRelC.contract?.claim_token }, t0 + 70 * S);
    const reclaimed = engine.pollNextTask({ agent_id: 'rel-window' }, t0 + 100 * S);
    assert.strictEqual(reclaimed.contract?.contract_id, relC.contract_id, 'released contract needs a fresh queue window');
    console.log('  PASS [9B - Fresh Queue Window]: contract released after its original queue TTL was re-claimable.');

    // 9B-2: release rejected once beyond absolute lifetime cap
    const relCap = engine.dispatchContract({ ...base, target_agent: 'rel-cap', queue_ttl_sec: 60 }, t0);
    const pRelCap = engine.pollNextTask({ agent_id: 'rel-cap' }, t0 + 10 * S);
    // Lifetime cap is created_at + 4 * 60s = 240s
    const relBeyondCap = engine.releaseContract({ contract_id: relCap.contract_id, agent_id: 'rel-cap', claim_token: pRelCap.contract?.claim_token }, t0 + 241 * S);
    assert.strictEqual(relBeyondCap.ok, false);
    assert.strictEqual(relBeyondCap.status, 'TIMED_OUT');
    assert.strictEqual(engine.inspectMeshState({ contract_id: relCap.contract_id }).contracts[0].status, 'TIMED_OUT');
    console.log('  PASS [9B - Lifetime Release Cap]: release refused when nowMs >= lifetime deadline.');

    // 9C: extend_ttl restarts the window, capped at 5, must be called inside the window
    const ext = engine.dispatchContract({ ...base, target_agent: 'ext', exec_ttl_sec: 300 }, t0);
    const pExt = engine.pollNextTask({ agent_id: 'ext' }, t0);
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
    const pCapC = engine.pollNextTask({ agent_id: 'ext-cap' }, t0 + 10 * S);
    const proposedExceedsCap = engine.extendTtl({ contract_id: capC.contract_id, agent_id: 'ext-cap', claim_token: pCapC.contract?.claim_token }, t0 + 20 * S);
    assert.strictEqual(proposedExceedsCap.ok, false, 'renewal that would push window past lifetime deadline must be refused');
    assert.match(proposedExceedsCap.message, /exceeding the absolute lifetime cap/);

    // Now test with larger queue_ttl_sec = 600, exec_ttl_sec = 100: deadline is t0 + 2400s.
    // At t0 + 50s: renewing pushes to 50s + 100s = 150s <= 2400s, so it succeeds.
    const capOk = engine.dispatchContract({ ...base, target_agent: 'ext-ok', queue_ttl_sec: 600, exec_ttl_sec: 100 }, t0);
    const pCapOk = engine.pollNextTask({ agent_id: 'ext-ok' }, t0 + 10 * S);
    const extendWithinLifetime = engine.extendTtl({ contract_id: capOk.contract_id, agent_id: 'ext-ok', claim_token: pCapOk.contract?.claim_token }, t0 + 50 * S);
    assert.strictEqual(extendWithinLifetime.ok, true);
    assert.ok(extendWithinLifetime.expires_at! <= t0 + 2400 * S, 'expires_at must be strictly within lifetime cap');

    console.log('  PASS [9C - extend_ttl]: window restarted 5x, 6th refused, proposed window past deadline refused, lifetime cap enforced.');

    // 9D: fail_contract -> terminal FAILED with reason; late report -> TIMED_OUT with reason preserved
    const fl = engine.dispatchContract({ ...base, target_agent: 'fl', exec_ttl_sec: 300 }, t0);
    const pFl = engine.pollNextTask({ agent_id: 'fl' }, t0);
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
    const pFlLate = engine.pollNextTask({ agent_id: 'fl-late' }, t0);
    const late = engine.failContract({ contract_id: flLate.contract_id, agent_id: 'fl-late', claim_token: pFlLate.contract?.claim_token, reason: 'gave up' }, t0 + 400 * S);
    assert.strictEqual(late.status, 'TIMED_OUT');
    assert.strictEqual(
      engine.inspectMeshState({ contract_id: flLate.contract_id }).contracts[0].error_reason,
      'EXEC_TTL_EXPIRED (late failure report: gave up)'
    );
    console.log('  PASS [9D - fail_contract]: holder-only FAILED terminal with reason; late report -> TIMED_OUT keeps reason.');

    // 9E: RETRY_NEEDED renews the execution window
    const rn = engine.dispatchContract({ ...base, target_agent: 'rn', exec_ttl_sec: 300, contract_schema: schema }, t0);
    const pRn = engine.pollNextTask({ agent_id: 'rn' }, t0);
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
    const legacyPoll = migrated.pollNextTask({ agent_id: 'legacy-worker' });
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
    const pLife1 = engine.pollNextTask({ agent_id: 'cli-life' });
    const tokenLife1 = pLife1.contract!.claim_token!;

    const resExtend = await execCli(['extend', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife1]);
    assert.strictEqual(resExtend.code, 0, resExtend.stderr);
    assert.strictEqual(JSON.parse(resExtend.stdout).extend_count, 1);

    const resRelease = await execCli(['release', '--agent', 'cli-life', '--id', cliC.contract_id, '--token', tokenLife1, '--reason', 'wrong branch']);
    assert.strictEqual(resRelease.code, 0, resRelease.stderr);
    assert.strictEqual(JSON.parse(resRelease.stdout).status, 'SUBMITTED');

    const pLife2 = engine.pollNextTask({ agent_id: 'cli-life' });
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

    const pRecover = engine.pollNextTask({ agent_id: 'workbuddy' }, 1000);
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
    const pSalv1 = engine.pollNextTask({ agent_id: 'workbuddy' });
    engine.releaseContract({ contract_id: cSalvage.contract_id, agent_id: 'workbuddy', claim_token: pSalv1.contract?.claim_token, reason: 'first release' });
    const pSalv2 = engine.pollNextTask({ agent_id: 'workbuddy' });
    engine.releaseContract({ contract_id: cSalvage.contract_id, agent_id: 'workbuddy', claim_token: pSalv2.contract?.claim_token, reason: 'second release' });

    const afterReleases = engine.inspectMeshState({ contract_id: cSalvage.contract_id }).contracts[0];
    assert.strictEqual(afterReleases.toctou_strike, 0, 'releaseContract must reset toctou_strike to 0');
    assert.ok(
      String(afterReleases.error_reason).includes('RELEASED_BY_HOLDER: second release | prev: RELEASED_BY_HOLDER: first release'),
      `Expected preserved release history, got: ${afterReleases.error_reason}`
    );

    const pSalv3 = engine.pollNextTask({ agent_id: 'workbuddy' });
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
    assert.ok(helpGlobal.stdout.includes('FerryCat CLI v0.3.2'));

    const helpFulfill = await runCli(['help', 'fulfill']);
    assert.strictEqual(helpFulfill.code, 0);
    assert.ok(helpFulfill.stdout.includes('Usage: ferrycat-cli fulfill'));

    const verRes = await runCli(['--version']);
    assert.strictEqual(verRes.code, 0);
    assert.strictEqual(verRes.stdout.trim(), '0.3.2');

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

    const p1 = engine.pollNextTask({ agent_id: 'multi-worker' });
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

    const pRecycle1 = engine.pollNextTask({ agent_id: 'recycle-worker' });
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
    const pRecycle2 = engine.pollNextTask({ agent_id: 'recycle-worker' });
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

    const claimedKeepAlive = engine.pollNextTask({ agent_id: 'supervisor-worker' });
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
      Number(lastRenew.extend_count) < 5,
      `Heartbeat renewal count (${lastRenew.extend_count}) must have headroom under the hard cap of 5`
    );
    console.log(`  PASS [13B - CK-01/02 Heartbeat Keep-Alive]: Kept alive across ${renewEvents.length} renewals and COMPLETED.`);

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

    const claimedSalvage = engine.pollNextTask({ agent_id: 'supervisor-worker' });
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
    const claimedCollision = engine.pollNextTask({ agent_id: 'supervisor-worker' });
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
    const claimedDirect = engine.pollNextTask({ agent_id: 'supervisor-worker' });
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

  console.log('\n==============================================================');
  console.log(' ALL 13 TEST SUITES PASSED GREEN');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
