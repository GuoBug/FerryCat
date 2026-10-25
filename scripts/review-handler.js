/**
 * Minimal Example Review Handler for FerryCat Daemon.
 * 
 * Demonstrates a declarative worker script invoked via execFile.
 * Receives the contract payload as JSON on standard input (stdin),
 * executes automated review checks, and outputs a JSON result to stdout.
 */
const fs = require('node:fs');

function main() {
  const stdinData = fs.readFileSync(0, 'utf8');
  if (!stdinData.trim()) {
    console.error('No contract received on stdin');
    process.exit(1);
  }

  const contract = JSON.parse(stdinData);
  console.log(JSON.stringify({
    ok: true,
    summary: `Automated review completed for contract ${contract.contract_id}: "${contract.title}"`,
    structured_output: {
      overall_verdict: 'APPROVED',
      summary: 'Automated static review passed with no blocking issues detected.',
      findings: []
    }
  }));
}

main();
