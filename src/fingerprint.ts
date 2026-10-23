import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { FileFingerprint, FilePointerInput } from './types.js';

const SENSITIVE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /credentials/i,
  /secret/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc)$/i,
  /(^|[\\/])\.git[\\/]config$/i,
];

export class SecurityPolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecurityPolicyError';
  }
}

export function assertSafePointerPath(workspaceRoot: string, rawPath: string): string {
  const normalizedRaw = rawPath.replace(/\\/g, '/');
  for (const pattern of SENSITIVE_PATTERNS) {
    if (pattern.test(normalizedRaw) || pattern.test(path.basename(normalizedRaw))) {
      throw new SecurityPolicyError(
        `Pointer rejected by security blacklist: "${rawPath}" matches sensitive file pattern.`
      );
    }
  }

  const resolvedRoot = path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(resolvedRoot, rawPath);
  const relative = path.relative(resolvedRoot, resolvedTarget);

  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new SecurityPolicyError(
      `Pointer rejected: "${rawPath}" escapes workspace_root "${workspaceRoot}".`
    );
  }

  // Symlink physical resolution and real path boundary guard
  if (fs.existsSync(resolvedTarget)) {
    try {
      const realTarget = fs.realpathSync(resolvedTarget);
      const realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
      const realRelative = path.relative(realRoot, realTarget);

      if (realRelative.startsWith('..') || path.isAbsolute(realRelative)) {
        throw new SecurityPolicyError(
          `Pointer rejected: "${rawPath}" resolves to symlink target "${realTarget}" outside workspace_root "${workspaceRoot}".`
        );
      }

      // Re-verify real target against sensitive blacklist to prevent symlink masking (e.g. foo.ts -> .env)
      const normalizedReal = realTarget.replace(/\\/g, '/');
      for (const pattern of SENSITIVE_PATTERNS) {
        if (pattern.test(normalizedReal) || pattern.test(path.basename(normalizedReal))) {
          throw new SecurityPolicyError(
            `Pointer rejected by security blacklist: symlink target "${realTarget}" matches sensitive file pattern.`
          );
        }
      }

      return realTarget;
    } catch (err) {
      if (err instanceof SecurityPolicyError) {
        throw err;
      }
      throw new SecurityPolicyError(
        `Pointer rejected: failed to physically resolve path "${rawPath}" safely (${(err as Error).message}).`
      );
    }
  }

  return resolvedTarget;
}

export function computeFullFileSha256(buffer: Buffer): string {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function extractFirstAndLastLine(content: string, maxLen: number = 48): {
  first_line: string;
  last_line: string;
  total_lines: number;
} {
  const lines = content.split(/\r?\n/);
  const nonEmpty = lines.filter((l) => l.trim().length > 0);
  if (nonEmpty.length === 0) {
    return { first_line: '', last_line: '', total_lines: lines.length };
  }
  return {
    first_line: nonEmpty[0].slice(0, maxLen),
    last_line: nonEmpty[nonEmpty.length - 1].slice(0, maxLen),
    total_lines: lines.length,
  };
}

export function computeFingerprints(
  workspaceRoot: string,
  pointers: FilePointerInput[],
  nowMs: number = Date.now()
): { fingerprints: FileFingerprint[]; recentlyModified: boolean } {
  if (!fs.existsSync(workspaceRoot)) {
    throw new Error(`workspace_root does not exist: "${workspaceRoot}"`);
  }

  let recentlyModified = false;
  const fingerprints: FileFingerprint[] = [];

  for (const ptr of pointers) {
    const absPath = assertSafePointerPath(workspaceRoot, ptr.path);
    if (!fs.existsSync(absPath)) {
      throw new Error(`Pointer target file does not exist: "${ptr.path}" (resolved: "${absPath}")`);
    }

    const stat = fs.statSync(absPath);
    if (!stat.isFile()) {
      throw new Error(`Pointer target is not a regular file: "${ptr.path}"`);
    }

    const buffer = fs.readFileSync(absPath);
    const sha256 = computeFullFileSha256(buffer);
    const text = buffer.toString('utf8');
    const { first_line, last_line, total_lines } = extractFirstAndLastLine(text);

    if (ptr.line_range) {
      const [startLine, endLine] = ptr.line_range;
      if (startLine > endLine) {
        throw new Error(
          `Invalid line_range [${startLine}, ${endLine}] for "${ptr.path}": startLine must be <= endLine.`
        );
      }
      if (startLine > total_lines) {
        throw new Error(
          `Invalid line_range [${startLine}, ${endLine}] for "${ptr.path}": file only has ${total_lines} lines.`
        );
      }
    }

    if (nowMs - stat.mtimeMs < 3000) {
      recentlyModified = true;
    }

    fingerprints.push({
      path: ptr.path,
      size: stat.size,
      mtime_ms: Math.floor(stat.mtimeMs),
      sha256,
      first_line,
      last_line,
      ...(ptr.line_range ? { line_range: ptr.line_range } : {}),
    });
  }

  return { fingerprints, recentlyModified };
}

export interface FingerprintVerificationResult {
  valid: boolean;
  reason?: 'FILE_MISSING' | 'SIZE_MISMATCH' | 'CONTENT_CHANGED' | 'SECURITY_REJECTED';
  detail?: string;
}

export interface PointerDriftItem {
  path: string;
  reason: 'FILE_MISSING' | 'SIZE_MISMATCH' | 'CONTENT_CHANGED' | 'SECURITY_REJECTED';
  detail: string;
}

export function verifyAllPointers(
  workspaceRoot: string,
  fingerprints: FileFingerprint[]
): {
  valid: boolean;
  firstFailure?: FingerprintVerificationResult;
  dirtyFiles: PointerDriftItem[];
} {
  const dirtyFiles: PointerDriftItem[] = [];
  for (const fp of fingerprints) {
    const res = verifySingleRun(workspaceRoot, [fp]);
    if (!res.valid && res.reason) {
      dirtyFiles.push({
        path: fp.path,
        reason: res.reason,
        detail: res.detail ?? res.reason,
      });
    }
  }
  if (dirtyFiles.length > 0) {
    return {
      valid: false,
      firstFailure: {
        valid: false,
        reason: dirtyFiles[0].reason,
        detail: dirtyFiles[0].detail,
      },
      dirtyFiles,
    };
  }
  return { valid: true, dirtyFiles: [] };
}

export function verifySingleRun(
  workspaceRoot: string,
  fingerprints: FileFingerprint[]
): FingerprintVerificationResult {
  for (const fp of fingerprints) {
    let absPath: string;
    try {
      // Worker-side defense-in-depth: re-verify security blacklist & workspace containment
      absPath = assertSafePointerPath(workspaceRoot, fp.path);
    } catch (err) {
      return {
        valid: false,
        reason: 'SECURITY_REJECTED',
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    // Step 1: Existence check
    if (!fs.existsSync(absPath)) {
      return {
        valid: false,
        reason: 'FILE_MISSING',
        detail: `File missing on worker disk: "${fp.path}"`,
      };
    }

    const stat = fs.statSync(absPath);

    // Step 2: Fast byte-size check
    if (stat.size !== fp.size) {
      return {
        valid: false,
        reason: 'SIZE_MISMATCH',
        detail: `File size changed for "${fp.path}": expected ${fp.size} bytes, got ${stat.size} bytes`,
      };
    }

    // Step 3: Full-file SHA-256 verification (never rely on mtime_ms to reject, and always hash full file)
    const buffer = fs.readFileSync(absPath);
    const currentSha256 = computeFullFileSha256(buffer);
    if (currentSha256 !== fp.sha256) {
      return {
        valid: false,
        reason: 'CONTENT_CHANGED',
        detail: `File content SHA-256 mismatch for "${fp.path}": expected ${fp.sha256.slice(0, 16)}..., got ${currentSha256.slice(0, 16)}...`,
      };
    }
  }

  return { valid: true };
}

function sleepSync(ms: number): void {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

/**
 * Verifies all file fingerprints. If a content/size mismatch is detected on the first read,
 * waits `retryDelayMs` (default 150ms) and re-checks once to rule out transient IDE buffer flushes.
 */
export function verifyFingerprintsWithRetry(
  workspaceRoot: string,
  fingerprints: FileFingerprint[],
  retryDelayMs: number = 150
): FingerprintVerificationResult {
  const firstCheck = verifySingleRun(workspaceRoot, fingerprints);
  if (firstCheck.valid || firstCheck.reason === 'SECURITY_REJECTED') {
    return firstCheck;
  }

  sleepSync(retryDelayMs);
  return verifySingleRun(workspaceRoot, fingerprints);
}
