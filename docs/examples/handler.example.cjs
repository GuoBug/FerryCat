#!/usr/bin/env node
/**
 * Reference `--exec-file` / daemon handler for FerryCat.
 *
 * Input  : the claimed contract as one JSON object on stdin
 *          (contract_id, task_type, title, context_summary, workspace_root, pointers,
 *           contract_schema, claim_token, exec_ttl_sec, ...).
 *          Lease context is also injected as env vars: FERRYCAT_CONTRACT_ID,
 *          FERRYCAT_TASK_TYPE, FERRYCAT_WORKSPACE_ROOT, FERRYCAT_TARGET_AGENT,
 *          FERRYCAT_CLAIM_TOKEN. Other host env vars are stripped unless passed via
 *          --pass-env / handler "pass_env".
 *
 * Output : exactly ONE stdout line with the delivery envelope:
 *            {"ferrycat_delivery":{"result_summary":"...","structured_output":{...}}}
 *          Every other stdout line is treated as a log and ignored, so logging is safe.
 *          Diagnostics may also go to stderr (kept in the salvage record on failure).
 *
 * Exit   : 0  -> the envelope is submitted via fulfill (TOCTOU + schema checks still apply)
 *          !0 -> the contract is marked FAILED with stderr as the reason
 *
 * Do not edit the pointer files: the supervisor re-verifies their SHA-256 at fulfill time.
 * Put proposed changes in structured_output.fixes instead (ADR-0004).
 *
 * Try it:
 *   ferrycat-cli worker --agent workbuddy --mode=exec --once \
 *     --exec-file docs/examples/handler.example.cjs --delivery envelope
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

function main() {
  const raw = fs.readFileSync(0, 'utf8');
  if (!raw.trim()) {
    console.error('handler: no contract payload on stdin');
    process.exit(1);
  }
  const contract = JSON.parse(raw);
  const root = process.env.FERRYCAT_WORKSPACE_ROOT || contract.workspace_root;
  console.log(`handler: reviewing ${contract.contract_id} (${contract.pointers.length} pointer(s))`);

  const findings = [];
  for (const pointer of contract.pointers) {
    const file = path.resolve(root, pointer.path);
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
    const [start, end] = pointer.line_range || [1, lines.length];
    for (let i = start - 1; i < Math.min(end, lines.length); i++) {
      if (/\bTODO\b|\bFIXME\b/.test(lines[i])) {
        findings.push({ severity: 'nit', path: pointer.path, line: i + 1, message: lines[i].trim() });
      }
    }
  }

  const delivery = {
    ferrycat_delivery: {
      result_summary: `Scanned ${contract.pointers.length} file(s); ${findings.length} TODO/FIXME marker(s) found.`,
      structured_output: {
        verdict: findings.length === 0 ? 'APPROVED' : 'CHANGES_REQUESTED',
        findings,
      },
    },
  };
  // Single line: JSON.stringify without indentation.
  process.stdout.write(`${JSON.stringify(delivery)}\n`);
}

main();
