import { FerryCatEngine } from '../src/engine.js';

const dbPath = process.argv[2];
const agentId = process.argv[3] || 'workbuddy';

if (!dbPath) {
  process.stderr.write('Missing dbPath argument\n');
  process.exit(1);
}

// Optional synchronization barrier timestamp so both child processes fire pollNextTask at the exact same millisecond
const startAtMs = Number(process.argv[4] || '0');
if (startAtMs > Date.now()) {
  const waitMs = startAtMs - Date.now();
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, waitMs);
}

const engine = new FerryCatEngine({ dbPath, defaultAgentName: agentId, fingerprintRetryDelayMs: 10 });
try {
  const res = await engine.pollNextTask({ agent_id: agentId });
  process.stdout.write(JSON.stringify(res) + '\n');
} finally {
  engine.close();
}
