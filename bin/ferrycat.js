#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
if (major < 22 || (major === 22 && minor < 5)) {
  console.error(
    `FerryCat requires Node.js >= 22.5.0 (current: ${process.version}). Please upgrade Node.js.`
  );
  process.exit(1);
}

const targetPath = fileURLToPath(new URL('../dist/index.js', import.meta.url));
const needsFlag = major === 22 && !process.execArgv.includes('--experimental-sqlite');

if (needsFlag) {
  const child = spawn(
    process.execPath,
    ['--experimental-sqlite', ...process.execArgv, targetPath, ...process.argv.slice(2)],
    { stdio: 'inherit', env: process.env }
  );

  child.on('exit', (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
    } else {
      process.exit(code ?? 0);
    }
  });
} else {
  await import(pathToFileURL(targetPath).href);
}
