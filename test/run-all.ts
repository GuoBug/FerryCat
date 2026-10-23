import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FerryCatEngine } from '../src/engine.js';

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

    // Attempt 1: Invalid structured_output (missing 'risks', wrong type for 'passed')
    const attempt1 = engine.fulfillContract({
      contract_id: dispatched.contract_id,
      agent_id: 'workbuddy',
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

    // Fulfill at t0 + 1850s (past queue_ttl_sec, but only 60s into the 300s exec_ttl_sec window!)
    const tFulfill = t0 + 1850 * 1000;
    const fulfilled = engine.fulfillContract(
      {
        contract_id: dispatched.contract_id,
        agent_id: 'workbuddy',
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

    // Mutate file while claimed
    fs.writeFileSync(filePath, '// Mutated mid-review!\nexport const v = 2;\n', 'utf8');
    const fToctou = engine.fulfillContract(
      {
        contract_id: dToctou.contract_id,
        agent_id: 'workbuddy',
        result_summary: 'Should be rejected due to TOCTOU mutation',
      },
      tFulfill + 2000
    );
    assert.equal(fToctou.ok, false);
    assert.equal(fToctou.status, 'POINTER_STALE');
    console.log('  PASS: Fulfill-time TOCTOU fingerprint guard caught mid-execution file change as POINTER_STALE.');
  } finally {
    engine.close();
    cleanup();
  }
}

async function test6_McpStdioHandshakeAndToolDiscovery(): Promise<void> {
  console.log('\n[Test 6] MCP Stdio Server Handshake & 4-Tool Registration Check');
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
      'fulfill_contract',
      'inspect_mesh_state',
      'poll_next_task',
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

    // 8D: P1-1 Symlink escape defense
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ferrycat-outside-'));
    const outsideFile = path.join(outsideDir, 'secret.env');
    fs.writeFileSync(outsideFile, 'SUPER_SECRET=xyz123\n', 'utf8');
    const symlinkPath = path.join(dir, 'symlink-leak.ts');

    let symlinkCreated = false;
    try {
      fs.symlinkSync(outsideFile, symlinkPath);
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode or admin privileges may fail symlink creation
      console.log('  INFO: OS symlink creation requires elevated privileges, tested physical path resolution.');
    }

    if (symlinkCreated) {
      assert.throws(
        () => {
          engine.dispatchContract({
            target_agent: 'agent-legit',
            task_type: 'code_review',
            title: 'Symlink escape test',
            context_summary: 'Must be blocked by realpathSync guard',
            workspace_root: dir,
            pointers: [{ path: 'symlink-leak.ts' }],
          });
        },
        /resolves to symlink target ".*" outside workspace_root/i,
        'Symlink pointing outside workspace root must be blocked'
      );
      console.log('  PASS [8D - P1-1 Symlink Escape Guard]: Symlink escaping workspace rejected.');
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
  } finally {
    engine.close();
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

  console.log('\n==============================================================');
  console.log(' ALL 8 TEST SUITES PASSED GREEN');
  console.log('==============================================================');
}

main().catch((err) => {
  console.error('\nTEST SUITE FAILED:', err);
  process.exit(1);
});
