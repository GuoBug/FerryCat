#!/usr/bin/env node
/**
 * FerryCat Static Analysis & Verification Gate Handler (Phase 3 / Step 2).
 *
 * Implements a high-precision static analysis and AST-level rule checker
 * conforming to the FerryCat execution supervisor protocol (src/supervisor.ts / ADR-0005).
 *
 * Wire Protocol (Supervisor Execution):
 *  - Input: Receives ContractPayload JSON via stdin (includes contract_id, workspace_root, pointers, contract_schema).
 *  - Execution: Executes in-process without network calls; verifies pointers and workspace boundary.
 *  - Output: Writes delivery envelope JSON to stdout: { ok: boolean, summary: string, result_summary: string, structured_output: { verdict, approved, findings: string[] } }.
 *  - Exit Code: Exits 0 on successful evaluation (even when CHANGES_REQUESTED); non-zero on unhandled fatal crash.
 *
 * Features:
 *  - Zero external dependencies (pure Node.js built-ins).
 *  - Workspace path escape containment (rejects traversal outside workspace_root while tolerating ..hidden files).
 *  - Multi-line comment and template literal state tracking (eliminates false positives across lines).
 *  - Contextual regex literal stripping (supporting return /re/, typeof /re/, etc.).
 *  - Modern secret detection (OpenAI sk-proj-, sk-svcacct-, classic sk-, GitHub, AWS, PEM) with left-boundary guard.
 *  - Dual-track scanning: .json files undergo JSON parse check followed by secret scanning.
 */

const fs = require('node:fs');
const path = require('node:path');

// Rule Definitions
// Note: Secret detection runs on RAW source (keys are embedded in strings).
// AST and syntax rules run on STRIPPED code (comments and string/regex literals removed).
const SECRET_RULES = [
  {
    id: 'SEC-001',
    name: 'Hardcoded Secrets & API Keys',
    severity: 'ERROR',
    description: 'Potential secret token, project API key, or private key committed in source.',
    // Enforces left-boundary [^A-Za-z0-9_] to eliminate false positives on task-, disk-, risk-, mask-
    regex: /(?:^|[^A-Za-z0-9_])(ghp_[a-zA-Z0-9]{36}|sk-(?:proj-|svcacct-)[a-zA-Z0-9_-]{20,}|sk-[a-zA-Z0-9]{20,}|AKIA[0-9A-Z]{16}|-----BEGIN (?:RSA |EC )?PRIVATE KEY-----)/,
  },
];

const CODE_RULES = [
  {
    id: 'AST-001',
    name: 'Loose Equality Operator',
    severity: 'WARNING',
    description: "Use of loose equality '==' or '!=' prone to type coercion bugs.",
    regex: /(?:^|[^=!<>])([!=]=)(?:[^=]|$)/,
  },
  {
    id: 'AST-002',
    name: 'Dangerous Dynamic Execution',
    severity: 'ERROR',
    description: 'Direct use of eval(), eval?.(), (0,eval)(), or Function() creates code injection risks.',
    regex: /(?:^|[^\w$.])(?:eval\s*(?:\?\.)?\(|\(\s*0\s*,\s*eval\s*\)\s*\(|(?:new\s+)?Function\s*\()/,
  },
  {
    id: 'AST-003',
    name: 'Stray Debugger Statement',
    severity: 'ERROR',
    description: 'Stray debugger statement left in source code.',
    regex: /\bdebugger\b\s*;?/,
  },
];

/**
 * Strips comments, string literals, and regex literals from a single line of JS/TS code,
 * tracking multi-line block comments and multi-line template literals.
 * Content is replaced with whitespace so line and character offsets remain preserved.
 */
function stripCodeLine(line, state) {
  let result = '';
  let i = 0;
  const len = line.length;

  while (i < len) {
    // 1. Inside multi-line block comment /* ... */
    if (state.inBlockComment) {
      if (line[i] === '*' && line[i + 1] === '/') {
        state.inBlockComment = false;
        result += '  ';
        i += 2;
      } else {
        result += ' ';
        i++;
      }
      continue;
    }

    // 2. Inside multi-line template literal `...`
    if (state.inTemplateLiteral) {
      if (line[i] === '`') {
        state.inTemplateLiteral = false;
        result += ' ';
        i++;
      } else if (line[i] === '\\' && i + 1 < len) {
        result += '  ';
        i += 2;
      } else {
        result += ' ';
        i++;
      }
      continue;
    }

    // 3. Single-line comment //
    if (line[i] === '/' && line[i + 1] === '/') {
      result += ' '.repeat(len - i);
      break;
    }

    // 4. Start of multi-line block comment /*
    if (line[i] === '/' && line[i + 1] === '*') {
      state.inBlockComment = true;
      result += '  ';
      i += 2;
      continue;
    }

    // 5. Template literal start `...`
    if (line[i] === '`') {
      result += ' ';
      i++;
      while (i < len && line[i] !== '`') {
        if (line[i] === '\\' && i + 1 < len) {
          result += '  ';
          i += 2;
        } else {
          result += ' ';
          i++;
        }
      }
      if (i < len && line[i] === '`') {
        result += ' ';
        i++;
      } else {
        // Did not close on this line -> enters multi-line template state
        state.inTemplateLiteral = true;
      }
      continue;
    }

    // 6. Regular string literals: '...', "..."
    if (line[i] === '"' || line[i] === "'") {
      const quote = line[i];
      result += ' ';
      i++;
      while (i < len && line[i] !== quote) {
        if (line[i] === '\\' && i + 1 < len) {
          result += '  ';
          i += 2;
        } else {
          result += ' ';
          i++;
        }
      }
      if (i < len) {
        result += ' '; // closing quote
        i++;
      }
      continue;
    }

    // 7. Regex literal /.../
    // Distinguishes division from regex literal by inspecting preceding token context
    if (line[i] === '/' && (i + 1 < len && line[i + 1] !== '/' && line[i + 1] !== '*')) {
      const prevTrimmed = result.trim();
      const prevChar = prevTrimmed.slice(-1);
      const isPunctuation = /[=(,[:!&|?;{}]/.test(prevChar);
      const isKeyword = /\b(?:return|typeof|yield|await|case|delete|void|throw)$/.test(prevTrimmed);
      const isArrow = /=>$/.test(prevTrimmed);
      const isRegexContext = !prevChar || isPunctuation || isKeyword || isArrow;

      if (isRegexContext) {
        result += ' ';
        i++;
        while (i < len && line[i] !== '/') {
          if (line[i] === '\\' && i + 1 < len) {
            result += '  ';
            i += 2;
          } else {
            result += ' ';
            i++;
          }
        }
        if (i < len && line[i] === '/') {
          result += ' '; // closing slash
          i++;
        }
        continue;
      }
    }

    // 8. Normal code character
    result += line[i];
    i++;
  }

  return result;
}

function analyzeFile(workspaceRoot, relPath) {
  const findings = [];
  const normalizedRoot = path.resolve(workspaceRoot);
  const absPath = path.resolve(normalizedRoot, relPath);

  // Path containment & Workspace Boundary check (P1)
  // Safely handles ..hidden.js while blocking true parent escapes like ../outside.js
  const relativeFromRoot = path.relative(normalizedRoot, absPath);
  if (relativeFromRoot === '..' || relativeFromRoot.startsWith('..' + path.sep) || path.isAbsolute(relativeFromRoot)) {
    findings.push(`[ERROR] ${relPath}:0 SEC-002: Path escapes workspace root directory.`);
    return findings;
  }

  // Check file existence & stat
  let stat;
  try {
    if (!fs.existsSync(absPath)) {
      findings.push(`[ERROR] ${relPath}:0 IO-001: File does not exist on disk.`);
      return findings;
    }
    stat = fs.statSync(absPath);
  } catch (err) {
    findings.push(`[ERROR] ${relPath}:0 IO-001: Failed to access file: ${err.message}`);
    return findings;
  }

  if (stat.isDirectory()) {
    findings.push(`[ERROR] ${relPath}:0 IO-002: Target path is a directory, not a file.`);
    return findings;
  }

  // Size guard: limit file to 2MB to prevent memory exhaustion
  if (stat.size > 2 * 1024 * 1024) {
    findings.push(`[ERROR] ${relPath}:0 IO-003: File exceeds maximum size limit of 2MB (${stat.size} bytes).`);
    return findings;
  }

  // Read content safely
  let content = '';
  try {
    content = fs.readFileSync(absPath, 'utf8');
  } catch (err) {
    findings.push(`[ERROR] ${relPath}:0 IO-004: Failed to read file: ${err.message}`);
    return findings;
  }

  const ext = path.extname(absPath).toLowerCase();
  const isJson = ext === '.json';

  // JSON Syntax verification
  if (isJson) {
    try {
      JSON.parse(content);
    } catch (err) {
      findings.push(`[ERROR] ${relPath}:1 SYNTAX-JSON: Invalid JSON syntax: ${err.message}`);
    }
  }

  // Line-by-line scanning
  const lines = content.split(/\r?\n/);
  const state = { inBlockComment: false, inTemplateLiteral: false };

  lines.forEach((rawLine, idx) => {
    const lineNum = idx + 1;

    // 1. Raw checks (Secrets) - executed on all files including .json
    for (const rule of SECRET_RULES) {
      const match = rule.regex.exec(rawLine);
      if (match) {
        const token = match[1] || match[0];
        findings.push(
          `[${rule.severity}] ${relPath}:${lineNum} ${rule.id}: ${rule.description} (Evidence: ${token.slice(0, 12)}...)`
        );
      }
    }

    // Skip AST/code rules on non-code files like JSON
    if (isJson) return;

    // 2. Stripped checks (AST-001, AST-002, AST-003)
    const codeLine = stripCodeLine(rawLine, state);
    if (!codeLine.trim()) return;

    for (const rule of CODE_RULES) {
      const match = rule.regex.exec(codeLine);
      if (match) {
        findings.push(
          `[${rule.severity}] ${relPath}:${lineNum} ${rule.id}: ${rule.description} (Evidence: ${rawLine.trim().slice(0, 80)})`
        );
      }
    }
  });

  return findings;
}

function runAnalysis(workspaceRoot, filePointers) {
  const allFindings = [];
  let filesScanned = 0;

  for (const ptr of filePointers) {
    const rel = typeof ptr === 'string' ? ptr : ptr.path;
    const findings = analyzeFile(workspaceRoot, rel);
    allFindings.push(...findings);
    filesScanned++;
  }

  const errorCount = allFindings.filter((f) => f.startsWith('[ERROR]')).length;
  const warningCount = allFindings.filter((f) => f.startsWith('[WARNING]')).length;
  const hasErrors = errorCount > 0;

  const verdict = hasErrors ? 'CHANGES_REQUESTED' : 'APPROVED';
  const approved = !hasErrors;

  const summary = `Static analysis gate scanned ${filesScanned} file(s): ${errorCount} error(s), ${warningCount} warning(s). Verdict: ${verdict}.`;

  return {
    verdict,
    approved,
    errorCount,
    warningCount,
    findings: allFindings,
    filesScanned,
    summary,
  };
}

async function main() {
  // If run with command-line arguments (direct CLI mode)
  if (process.argv.length > 2) {
    const files = process.argv.slice(2);
    const result = runAnalysis(process.cwd(), files);
    console.log(JSON.stringify(result, null, 2));
    process.exit(result.approved ? 0 : 1);
  }

  // Otherwise, read contract from stdin (FerryCat supervisor protocol)
  let stdinData = '';
  try {
    stdinData = fs.readFileSync(0, 'utf8');
  } catch (err) {
    console.error('Failed to read from stdin:', err);
    process.exit(1);
  }

  if (!stdinData.trim()) {
    console.error('No contract data received on stdin.');
    process.exit(1);
  }

  const contract = JSON.parse(stdinData);
  const workspaceRoot = contract.workspace_root || process.env.FERRYCAT_WORKSPACE_ROOT || process.cwd();
  const pointers = contract.pointers || [];

  const analysis = runAnalysis(workspaceRoot, pointers);

  const output = {
    ok: analysis.approved,
    summary: analysis.summary,
    result_summary: `### Static Analysis & Verification Gate Report\n\n` +
      `- **Contract ID**: \`${contract.contract_id}\`\n` +
      `- **Verdict**: **${analysis.verdict}** (approved: \`${analysis.approved}\`)\n` +
      `- **Files Scanned**: ${analysis.filesScanned}\n` +
      `- **Issues Detected**: ${analysis.errorCount} error(s), ${analysis.warningCount} warning(s)\n\n` +
      (analysis.findings.length > 0
        ? `#### Findings\n` + analysis.findings.map((f) => `- ${f}`).join('\n')
        : `✅ Clean inspection. No static analysis or security violations detected.`),
    structured_output: {
      verdict: analysis.verdict,
      approved: analysis.approved,
      findings: analysis.findings,
    },
  };

  process.stdout.write(JSON.stringify(output));
}

// Export for test suite integration (test/run-all.ts Test 17)
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    stripCodeLine,
    analyzeFile,
    runAnalysis,
    SECRET_RULES,
    CODE_RULES,
  };
}

if (require.main === module) {
  main().catch((err) => {
    console.error('Static analysis gate fatal error:', err);
    process.exit(1);
  });
}
