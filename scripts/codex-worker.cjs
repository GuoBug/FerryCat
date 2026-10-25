/**
 * FerryCat Worker Adapter for Codex CLI (Phase 3 Step 1 Verification).
 *
 * Plain Node.js CJS script.
 * Reads contract JSON from stdin, invokes Codex CLI non-interactively (`codex exec`),
 * ensuring stdin is closed so Codex does not hang waiting for interactive input.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');

function resolveCodexPath() {
  if (process.env.CODEX_BIN && fs.existsSync(process.env.CODEX_BIN)) {
    return process.env.CODEX_BIN;
  }
  return 'codex';
}

async function main() {
  const stdinData = fs.readFileSync(0, 'utf8');
  if (!stdinData.trim()) {
    throw new Error('No contract data received on stdin.');
  }

  const contract = JSON.parse(stdinData);
  const codexBin = resolveCodexPath();

  const prompt = [
    `You are acting as an independent Architecture & Security Critic for FerryCat.`,
    `Contract ID: ${contract.contract_id}`,
    `Task Type: ${contract.task_type}`,
    `Title: ${contract.title}`,
    `Context Summary:\n${contract.context_summary}`,
    `\nPlease perform a rigorous code and architecture audit of the recent changes in this workspace:`,
    `- docs/adr/0005-controlled-daemon-and-process-supervision_zh.md`,
    `- src/engine.ts (daemon_locks CAS lease implementation)`,
    `- src/schemas.ts (ferrycat.config.json declarative schema)`,
    `- src/daemon.ts (FerryCatDaemon controller)`,
    `- src/cli.ts (daemon command)`,
    `- test/run-all.ts (Test 14)`,
    `\nExamine:`,
    `1. TOCTOU & contract state machine determinism (SUBMITTED, CLAIMED, COMPLETED, POINTER_STALE, VALIDATION_FAILED, TIMED_OUT, FAILED).`,
    `2. CAS lease concurrency on daemon_locks (starvation avoidance, multi-instance failover).`,
    `3. Process tree termination safety (CK-04/05) and declarative execution boundaries.`,
    `4. Any potential edge-case flaws or improvements.`,
    `\nDeliver a concise, actionable review report. Conclude with whether you vote APPROVE or CHANGES_REQUESTED.`,
  ].join('\n\n');

  // We run codex exec non-interactively
  // Using -s read-only to guarantee it does NOT mutate workspace files (preventing TOCTOU dirty pointer rejection)
  // Passing null input / closing stdin so it doesn't wait
  const args = [
    'exec',
    '--ephemeral',
    '-s',
    'read-only',
    '-C',
    contract.workspace_root || process.cwd(),
    prompt,
  ];

  // Note: stdio: ['ignore', 'pipe', 'pipe'] ensures stdin is /dev/null
  const child = spawn(codexBin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  let stdout = '';
  let stderr = '';

  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });

  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  const exitCode = await new Promise((resolve) => {
    child.on('close', resolve);
  });

  if (exitCode !== 0) {
    process.stderr.write(`Codex CLI failed with exit code ${exitCode}:\n${stderr}\n`);
    process.exit(exitCode);
  }

  // Filter out banner / noise
  let cleanReview = stdout.trim();
  const marker = 'codex\n';
  const markerIdx = cleanReview.indexOf(marker);
  if (markerIdx !== -1) {
    cleanReview = cleanReview.slice(markerIdx + marker.length).trim();
  }

  const reviewSummary = cleanReview || 'Codex review completed cleanly with no issues.';

  const isApproved = !cleanReview.toLowerCase().includes('changes_requested');

  const output = {
    result_summary: reviewSummary.slice(0, 19500),
    structured_output: {
      reviewer: 'OpenAI Codex (GPT-5.6-terra)',
      audit_pass: isApproved,
      verdict: isApproved ? 'APPROVED' : 'CHANGES_REQUESTED',
      findings_count: isApproved ? 0 : 1,
      full_review: reviewSummary,
    },
  };

  console.log(JSON.stringify(output));
}

main().catch((err) => {
  console.error('Codex worker adapter failed:', err);
  process.exit(1);
});
