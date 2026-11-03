#!/usr/bin/env node
/**
 * FerryCat Zero-Dependency Static Linter, Typechecker & Hygiene Gate (REQ-ENG-03).
 *
 * Enforces in local development (`npm run lint`) and CI (`.github/workflows/ci.yml`):
 *   1. TypeScript strict typecheck (`tsc --noEmit`) across `src/` and `test/` trees,
 *      reading compilerOptions directly from `tsconfig.json` so there is no config drift
 *   2. FerryCat Static Analysis Gate (`scripts/static-analysis-gate.cjs`) dogfooded recursively
 *      across `src/`, `bin/`, `scripts/`, `docs/examples/`, and root JSON manifests
 *   3. MCP stdio transport purity: every `src/` `.ts` module outside the CLI-only entrypoints
 *      (`src/cli.ts`, `src/demo.ts`, `src/init.ts`) is scanned to prevent accidental stdout
 *      writes (`console.log` / `process.stdout.write`) that would corrupt JSON-RPC frames
 *   4. Hygiene & concurrency invariants: zero UTF-8 BOMs in tracked source/config files,
 *      zero git conflict markers, and zero synchronous `Atomics.wait` / `SharedArrayBuffer`
 *      calls in production `src/` (FC-203)
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const require = createRequire(import.meta.url);
const { runAnalysis, stripCodeLine } = require('./static-analysis-gate.cjs');

const errors = [];

// Recursively list files under dirRel matching any extension in exts.
function listFiles(dirRel, exts) {
  const absDir = path.join(ROOT, dirRel);
  if (!fs.existsSync(absDir)) return [];
  const results = [];
  const walk = (currAbs, currRel) => {
    for (const entry of fs.readdirSync(currAbs, { withFileTypes: true })) {
      const nextAbs = path.join(currAbs, entry.name);
      const nextRel = path.posix.join(currRel.replace(/\\/g, '/'), entry.name);
      if (entry.isDirectory()) {
        walk(nextAbs, nextRel);
      } else if (entry.isFile() && exts.includes(path.extname(entry.name).toLowerCase())) {
        results.push(nextRel);
      }
    }
  };
  walk(absDir, dirRel);
  return results.sort();
}

// 1. TypeScript strict typecheck (tsc --noEmit across src/ and test/ using tsconfig.json options)
const tsconfigRaw = JSON.parse(fs.readFileSync(path.join(ROOT, 'tsconfig.json'), 'utf8'));
const compilerOpts = tsconfigRaw.compilerOptions || {};
const tscFlags = ['--noEmit'];
for (const [key, val] of Object.entries(compilerOpts)) {
  if (key === 'outDir' || key === 'rootDir' || key === 'declaration' || key === 'sourceMap') continue;
  if (typeof val === 'boolean') {
    if (val) tscFlags.push(`--${key}`);
  } else if (typeof val === 'string') {
    tscFlags.push(`--${key}`, val);
  } else {
    errors.push(
      `[TSC] tsconfig.json compilerOptions.${key} has unsupported type "${Array.isArray(val) ? 'array' : typeof val}" and cannot be mapped to a single tsc CLI flag; handle it explicitly in scripts/lint.js.`
    );
  }
}

const srcTsFiles = listFiles('src', ['.ts']);
const testTsFiles = listFiles('test', ['.ts']);
const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const tscRes = spawnSync(process.execPath, [tscBin, ...tscFlags, ...srcTsFiles, ...testTsFiles], {
  cwd: ROOT,
  encoding: 'utf8',
});
if (tscRes.status !== 0) {
  errors.push(`[TSC] TypeScript --noEmit failed:\n${(tscRes.stdout || '') + (tscRes.stderr || '')}`.trim());
}

// 2. Dogfood FerryCat Static Analysis Gate across source, bin, scripts, examples, and JSON manifests
const gateTargets = [
  ...srcTsFiles,
  ...listFiles('bin', ['.js']),
  ...listFiles('scripts', ['.js', '.cjs']),
  ...listFiles('docs/examples', ['.cjs', '.json']),
  'package.json',
  'tsconfig.json',
  'server.json',
  'glama.json',
  'ferrycat.config.example.json',
];

const gateResult = runAnalysis(ROOT, gateTargets);
if (!gateResult.approved || gateResult.warningCount > 0) {
  for (const finding of gateResult.findings) {
    errors.push(`[GATE] ${finding}`);
  }
}

// 3. MCP stdio transport purity check: scan all src/ .ts files except CLI-only modules.
//    (New shared modules added under src/ are automatically covered without manual allowlists.)
const CLI_ONLY_MODULES = new Set([
  'src/cli.ts',
  'src/demo.ts',
  'src/init.ts',
]);

for (const rel of srcTsFiles) {
  if (CLI_ONLY_MODULES.has(rel)) continue;
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = content.split(/\r?\n/);
  const state = { inBlockComment: false, inTemplateLiteral: false };
  let afterMcpServerInit = rel !== 'src/index.ts';
  lines.forEach((rawLine, idx) => {
    const code = stripCodeLine(rawLine, state);
    if (rel === 'src/index.ts' && /\bnew\s+McpServer\s*\(/.test(code)) {
      afterMcpServerInit = true;
    }
    if (
      afterMcpServerInit &&
      (/\bconsole\.log\s*\(/.test(code) || /\bprocess\.stdout\.write\s*\(/.test(code))
    ) {
      errors.push(
        `[MCP-STDIO] ${rel}:${idx + 1}: stdout write detected in MCP server module (use console.error so JSON-RPC frames on stdout are not corrupted)`
      );
    }
  });
}

// 4. Hygiene & FC-203 non-blocking invariant checks
for (const rel of gateTargets) {
  const raw = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  if (raw.charCodeAt(0) === 0xfeff) {
    errors.push(`[HYGIENE] ${rel}:1: unexpected UTF-8 BOM`);
  }
  const lines = raw.split(/\r?\n/);
  lines.forEach((line, idx) => {
    if (/^(<<<<<<<|=======|>>>>>>>)(\s|$)/.test(line)) {
      errors.push(`[HYGIENE] ${rel}:${idx + 1}: git merge conflict marker detected`);
    }
  });
}

for (const rel of srcTsFiles) {
  const content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const lines = content.split(/\r?\n/);
  const state = { inBlockComment: false, inTemplateLiteral: false };
  lines.forEach((rawLine, idx) => {
    const code = stripCodeLine(rawLine, state);
    if (/\bAtomics\.wait\b/.test(code) || /\bSharedArrayBuffer\b/.test(code)) {
      errors.push(`[FC-203] ${rel}:${idx + 1}: synchronous sleep primitive forbidden in production src/`);
    }
  });
}

if (errors.length > 0) {
  console.error(`FerryCat lint failed with ${errors.length} issue(s):\n  - ${errors.join('\n  - ')}`);
  process.exit(1);
}

console.log(
  `FerryCat lint passed: tsc --noEmit clean, ${gateResult.filesScanned} files passed static analysis & hygiene checks (0 errors, 0 warnings).`
);
