import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { MAX_GIT_PATCH_BYTES } from './schemas.js';
import type { ArtifactPointer, FileFingerprint, FilePointerInput } from './types.js';

export { MAX_GIT_PATCH_BYTES };

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

/**
 * Sensitive file patterns enforced on diff headers (`diff --git`, `---`, `+++`).
 * Uses exact sensitive basenames and key/cert extensions rather than broad `secret` / `credentials`
 * substring matches so legitimate source files (e.g. `src/secretManager.ts`, `docs/credentials-guide.md`)
 * are not falsely blocked. Note: this checks diff header target paths, not patch body content.
 */
const PATCH_HEADER_SENSITIVE_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env(\..+)?$/i,
  /\.(pem|key|p12|pfx)$/i,
  /(^|[\\/])id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /(^|[\\/])(credentials|secrets?)(\.(json|ya?ml|toml|ini|conf|env|txt))?$/i,
  /(^|[\\/])\.(npmrc|pypirc|netrc)$/i,
  /(^|[\\/])\.git[\\/]config$/i,
];

function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    const inner = trimmed.slice(1, -1);
    const bytes: number[] = [];
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '\\' && i + 1 < inner.length) {
        const next = inner[i + 1];
        if (next >= '0' && next <= '7') {
          const octal = inner.slice(i + 1, i + 4).match(/^[0-7]{1,3}/)?.[0] ?? next;
          bytes.push(parseInt(octal, 8));
          i += octal.length;
          continue;
        }
        i += 1;
        if (next === 'n') bytes.push(0x0a);
        else if (next === 'r') bytes.push(0x0d);
        else if (next === 't') bytes.push(0x09);
        else if (next === '\\') bytes.push(0x5c);
        else if (next === '"') bytes.push(0x22);
        else bytes.push(...Buffer.from(next, 'utf8'));
      } else {
        bytes.push(...Buffer.from(inner[i], 'utf8'));
      }
    }
    return Buffer.from(bytes).toString('utf8');
  }
  return trimmed;
}

function parseDiffGitHeaderPaths(rest: string): string[] {
  const tokens: string[] = [];
  const trimmed = rest.trim();
  if (!trimmed) return tokens;

  // Handle C-quoted paths: diff --git "a/my file.ts" "b/my file.ts"
  if (trimmed.includes('"')) {
    const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(trimmed)) !== null) {
      tokens.push(unquoteGitPath(m[0]));
    }
    return tokens;
  }

  // Handle unquoted paths with or without spaces: diff --git a/my file.ts b/my file.ts
  const bSplitIdx = trimmed.indexOf(' b/');
  if (bSplitIdx > 0 && trimmed.startsWith('a/')) {
    tokens.push(trimmed.slice(0, bSplitIdx).trim());
    tokens.push(trimmed.slice(bSplitIdx + 1).trim());
    return tokens;
  }

  return trimmed.split(/\s+/);
}

function normalizeRelPointerPath(rawPath: string): string {
  return rawPath
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '');
}

function assertSafePatchRelPath(rawPath: string): string {
  const cleaned = unquoteGitPath(rawPath).replace(/\\/g, '/');
  if (!cleaned || cleaned === '/dev/null' || cleaned === 'dev/null') {
    return '';
  }
  const stripped = cleaned.replace(/^[ab]\//, '').replace(/^(\.\/)+/, '');
  if (!stripped || stripped === '/dev/null') {
    return '';
  }
  if (
    stripped.startsWith('/') ||
    /^[A-Za-z]:/.test(stripped) ||
    /(^|\/)\.\.(\/|$)/.test(stripped)
  ) {
    throw new SecurityPolicyError(
      `Git patch rejected: diff header path "${rawPath}" escapes workspace boundary.`
    );
  }
  for (const pattern of PATCH_HEADER_SENSITIVE_PATTERNS) {
    if (pattern.test(stripped) || pattern.test(path.basename(stripped))) {
      throw new SecurityPolicyError(
        `Git patch rejected by security blacklist: diff header "${rawPath}" matches sensitive file pattern.`
      );
    }
  }
  return stripped;
}

interface GitPatchFileBlock {
  paths: string[];
  hunks: number;
  changedLines: number;
}

/**
 * Statefully walks a unified diff and groups its lines into per-file blocks.
 *
 * Statefulness is load-bearing: a hunk body line can itself begin with `--- ` / `+++ `
 * (a removed line whose content starts with `--`, or an added line starting with `++`).
 * Only outside an open hunk is a `--- ` / `+++ ` line treated as a file header, so payload
 * lines can no longer be mis-parsed as headers or injected as bogus touched paths.
 *
 * Hunk extents are tracked from the `@@ -l,s +l,s @@` counts rather than guessed, which is
 * what makes the "no hunk / no changed content" gate below reliable.
 */
function parseGitPatchBlocks(gitPatch: string): {
  blocks: GitPatchFileBlock[];
  touched: Set<string>;
  hasDiffHeader: boolean;
} {
  const blocks: GitPatchFileBlock[] = [];
  const touched = new Set<string>();
  let hasDiffHeader = false;
  let current: GitPatchFileBlock | null = null;
  let oldRemaining = 0;
  let newRemaining = 0;
  let inHunk = false;

  for (const line of gitPatch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      hasDiffHeader = true;
      inHunk = false;
      oldRemaining = 0;
      newRemaining = 0;
      const block: GitPatchFileBlock = { paths: [], hunks: 0, changedLines: 0 };
      blocks.push(block);
      current = block;
      for (const part of parseDiffGitHeaderPaths(line.slice('diff --git '.length).trim())) {
        const safe = assertSafePatchRelPath(part);
        if (safe) {
          block.paths.push(safe);
          touched.add(safe);
        }
      }
      continue;
    }

    if (inHunk) {
      if (line.startsWith('\\')) continue; // "\ No newline at end of file"
      if (line.startsWith('+')) {
        if (newRemaining > 0) newRemaining -= 1;
        if (current) current.changedLines += 1;
      } else if (line.startsWith('-')) {
        if (oldRemaining > 0) oldRemaining -= 1;
        if (current) current.changedLines += 1;
      } else {
        if (oldRemaining > 0) oldRemaining -= 1;
        if (newRemaining > 0) newRemaining -= 1;
      }
      if (oldRemaining <= 0 && newRemaining <= 0) inHunk = false;
      continue;
    }

    if (line.startsWith('@@')) {
      const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (!match) {
        throw new Error(
          `MALFORMED_HUNK_HEADER: cannot parse hunk extent from "${line.slice(0, 60)}" (FC-202).`
        );
      }
      hasDiffHeader = true;
      if (current === null) {
        current = { paths: [], hunks: 0, changedLines: 0 };
        blocks.push(current);
      }
      oldRemaining = match[2] === undefined ? 1 : Number(match[2]);
      newRemaining = match[4] === undefined ? 1 : Number(match[4]);
      current.hunks += 1;
      inHunk = oldRemaining > 0 || newRemaining > 0;
      continue;
    }

    if (line.startsWith('--- ') || line.startsWith('+++ ')) {
      hasDiffHeader = true;
      // A fresh `--- ` after a completed file block starts a new block (diff without `diff --git`)
      if (current === null || (line.startsWith('--- ') && current.hunks > 0)) {
        current = { paths: [], hunks: 0, changedLines: 0 };
        blocks.push(current);
      }
      const afterPrefix = line.slice(4).trim();
      const rawTarget = afterPrefix.startsWith('"')
        ? (afterPrefix.match(/^"((?:[^"\\]|\\.)*)"/)?.[0] ?? afterPrefix.split('\t')[0].trim())
        : afterPrefix.split('\t')[0].trim();
      const safe = assertSafePatchRelPath(rawTarget);
      if (safe) {
        current.paths.push(safe);
        touched.add(safe);
      }
      continue;
    }
  }

  return { blocks, touched, hasDiffHeader };
}

/**
 * Validates an optional unified git diff patch payload (FC-202):
 *  - Non-empty UTF-8 string without binary null bytes
 *  - Bounded to MAX_GIT_PATCH_BYTES (512KB)
 *  - Scans diff header paths (diff --git / --- / +++) against workspace escape and sensitive file blacklists
 *  - Requires at least one valid unified diff header (`NOT_A_UNIFIED_DIFF` if prose/empty)
 *  - Requires every declared file block to carry at least one `@@` hunk (`EMPTY_PATCH_HUNKS`)
 *    and at least one `+` / `-` changed content line (`EMPTY_PATCH_CONTENT`), so a header-only
 *    patch can never stand in for a reviewable diff
 *  - When `requiredPointers` is provided, requires `touchedPaths` to cover every pointer path (`PATCH_DOES_NOT_COVER_POINTERS`)
 *  - Computes deterministic SHA-256 hex digest of the patch content
 *
 * Known limitation: mode-only changes (`old mode` / `new mode` with no hunk) and text-encoded
 * binary diffs (`GIT binary patch`) carry no `@@` hunk and are therefore rejected. Self-contained
 * review is a text-diff feature; use a normal on-disk contract for those cases.
 */
export function assertSafeGitPatch(
  gitPatch: string,
  requiredPointers?: Array<{ path: string } | string>
): {
  sha256: string;
  byteLength: number;
  touchedPaths: string[];
} {
  if (typeof gitPatch !== 'string' || gitPatch.trim().length === 0) {
    throw new Error('git_patch must be a non-empty string when provided (FC-202).');
  }
  if (gitPatch.includes('\0')) {
    throw new SecurityPolicyError('Git patch rejected: payload contains binary null bytes.');
  }
  const buf = Buffer.from(gitPatch, 'utf8');
  if (buf.byteLength > MAX_GIT_PATCH_BYTES) {
    throw new Error(
      `git_patch size (${buf.byteLength} bytes) exceeds maximum allowed limit of ${MAX_GIT_PATCH_BYTES} bytes (512KB) (FC-202).`
    );
  }

  const { blocks, touched, hasDiffHeader } = parseGitPatchBlocks(gitPatch);

  if (!hasDiffHeader || touched.size === 0) {
    throw new Error(
      'NOT_A_UNIFIED_DIFF: git_patch must be a valid unified diff containing at least one file diff header (diff --git / --- / +++) (FC-202).'
    );
  }

  // R1: a header-only patch names files without carrying any diff content. Reject it so
  // `SELF_CONTAINED` can never be unlocked by a patch the reviewer cannot actually read.
  const headerOnly = Array.from(
    new Set(blocks.filter((b) => b.paths.length > 0 && b.hunks === 0).flatMap((b) => b.paths))
  );
  if (headerOnly.length > 0) {
    throw new Error(
      `EMPTY_PATCH_HUNKS: git_patch file block(s) [${headerOnly.join(', ')}] declare a diff header but carry no "@@ ... @@" hunk; a header-only patch is not reviewable (FC-202).`
    );
  }

  const contentless = Array.from(
    new Set(
      blocks
        .filter((b) => b.paths.length > 0 && b.hunks > 0 && b.changedLines === 0)
        .flatMap((b) => b.paths)
    )
  );
  if (contentless.length > 0) {
    throw new Error(
      `EMPTY_PATCH_CONTENT: git_patch file block(s) [${contentless.join(', ')}] contain hunk headers but no "+" / "-" changed content line; a context-only hunk carries no reviewable change (FC-202).`
    );
  }

  if (requiredPointers && requiredPointers.length > 0) {
    const missingPointers: string[] = [];
    for (const ptr of requiredPointers) {
      const rawPtr = typeof ptr === 'string' ? ptr : ptr.path;
      const normPtr = normalizeRelPointerPath(rawPtr);
      if (normPtr && !touched.has(normPtr)) {
        missingPointers.push(normPtr);
      }
    }
    if (missingPointers.length > 0) {
      throw new Error(
        `PATCH_DOES_NOT_COVER_POINTERS: git_patch touched [${Array.from(touched).join(', ')}] does not cover pointer file(s) [${missingPointers.join(', ')}] (FC-202).`
      );
    }
  }

  return {
    sha256: computeFullFileSha256(buf),
    byteLength: buf.byteLength,
    touchedPaths: Array.from(touched),
  };
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

/**
 * Verifies pointer files at fulfillment/pre-flight time for mutation tasks
 * (`implementation` | `test_generation`).
 *
 * Unlike read-only review tasks (`code_review` | `architecture_audit`), mutation tasks
 * are expected to modify pointer files on disk after claiming the contract. Therefore:
 * - `SECURITY_REJECTED` (workspace escape / sensitive file / symlink escape) and
 *   `FILE_MISSING` (deleted pointer target) remain hard failures (`valid: false`).
 * - `SIZE_MISMATCH` and `CONTENT_CHANGED` are permitted; modified files are recorded in
 *   `dirtyFiles` for audit visibility, and every pointer's post-mutation SHA-256 is
 *   captured in `verifiedShaMap` so `verified_sha256` records the exact delivered state
 *   while `pointers` preserves the pre-mutation baseline.
 */
export function verifyAndSnapshotMutationPointers(
  workspaceRoot: string,
  fingerprints: FileFingerprint[],
  artifacts?: Array<ArtifactPointer | string>
): {
  valid: boolean;
  firstFailure?: FingerprintVerificationResult;
  dirtyFiles: PointerDriftItem[];
  verifiedShaMap: Record<string, string>;
  noOp: boolean;
} {
  const dirtyFiles: PointerDriftItem[] = [];
  const blockingFailures: PointerDriftItem[] = [];
  const verifiedShaMap: Record<string, string> = {};
  let addedArtifactCount = 0;

  for (const fp of fingerprints) {
    let absPath: string;
    try {
      absPath = assertSafePointerPath(workspaceRoot, fp.path);
    } catch (err) {
      const item: PointerDriftItem = {
        path: fp.path,
        reason: 'SECURITY_REJECTED',
        detail: err instanceof Error ? err.message : String(err),
      };
      dirtyFiles.push(item);
      blockingFailures.push(item);
      continue;
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      const item: PointerDriftItem = {
        path: fp.path,
        reason: 'FILE_MISSING',
        detail: `File missing on worker disk: "${fp.path}"`,
      };
      dirtyFiles.push(item);
      blockingFailures.push(item);
      continue;
    }

    const stat = fs.statSync(absPath);
    const buffer = fs.readFileSync(absPath);
    const currentSha256 = computeFullFileSha256(buffer);
    verifiedShaMap[fp.path] = currentSha256;

    if (stat.size !== fp.size) {
      dirtyFiles.push({
        path: fp.path,
        reason: 'SIZE_MISMATCH',
        detail: `File size changed for "${fp.path}": baseline ${fp.size} bytes -> post-mutation ${stat.size} bytes`,
      });
    } else if (currentSha256 !== fp.sha256) {
      dirtyFiles.push({
        path: fp.path,
        reason: 'CONTENT_CHANGED',
        detail: `File content SHA-256 updated for "${fp.path}": baseline ${fp.sha256.slice(0, 16)}... -> post-mutation ${currentSha256.slice(0, 16)}...`,
      });
    }
  }

  if (artifacts && artifacts.length > 0) {
    for (const entry of artifacts) {
      const rawArtifact = typeof entry === 'string' ? entry : entry.path;
      if (!rawArtifact || verifiedShaMap[rawArtifact]) continue;
      let absArtifact: string;
      try {
        absArtifact = assertSafePointerPath(workspaceRoot, rawArtifact);
      } catch (err) {
        const item: PointerDriftItem = {
          path: rawArtifact,
          reason: 'SECURITY_REJECTED',
          detail: err instanceof Error ? err.message : String(err),
        };
        dirtyFiles.push(item);
        blockingFailures.push(item);
        continue;
      }

      if (!fs.existsSync(absArtifact) || !fs.statSync(absArtifact).isFile()) {
        const item: PointerDriftItem = {
          path: rawArtifact,
          reason: 'FILE_MISSING',
          detail: `Declared artifact file missing on worker disk: "${rawArtifact}"`,
        };
        dirtyFiles.push(item);
        blockingFailures.push(item);
        continue;
      }

      const buffer = fs.readFileSync(absArtifact);
      verifiedShaMap[rawArtifact] = computeFullFileSha256(buffer);
      addedArtifactCount++;
    }
  }

  if (blockingFailures.length > 0) {
    return {
      valid: false,
      firstFailure: {
        valid: false,
        reason: blockingFailures[0].reason,
        detail: blockingFailures[0].detail,
      },
      dirtyFiles,
      verifiedShaMap: {},
      noOp: false,
    };
  }

  return {
    valid: true,
    dirtyFiles,
    verifiedShaMap,
    noOp: dirtyFiles.length === 0 && addedArtifactCount === 0,
  };
}

/**
 * Verifies a COMPLETED mutation contract's on-disk files against its committed
 * post-mutation `verified_sha256` snapshot (ADR-0006).
 */
export function verifyCommittedMutationSnapshot(
  workspaceRoot: string,
  verifiedShaMap: Record<string, string>
): {
  valid: boolean;
  firstFailure?: FingerprintVerificationResult;
  dirtyFiles: PointerDriftItem[];
} {
  const dirtyFiles: PointerDriftItem[] = [];
  for (const [rawPath, committedSha] of Object.entries(verifiedShaMap)) {
    let absPath: string;
    try {
      absPath = assertSafePointerPath(workspaceRoot, rawPath);
    } catch (err) {
      dirtyFiles.push({
        path: rawPath,
        reason: 'SECURITY_REJECTED',
        detail: err instanceof Error ? err.message : String(err),
      });
      continue;
    }

    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) {
      dirtyFiles.push({
        path: rawPath,
        reason: 'FILE_MISSING',
        detail: `Delivered file missing on disk: "${rawPath}"`,
      });
      continue;
    }

    const buffer = fs.readFileSync(absPath);
    const currentSha256 = computeFullFileSha256(buffer);
    if (currentSha256 !== committedSha) {
      dirtyFiles.push({
        path: rawPath,
        reason: 'CONTENT_CHANGED',
        detail: `Post-completion SHA-256 mismatch for "${rawPath}": expected committed ${committedSha.slice(0, 16)}..., got ${currentSha256.slice(0, 16)}...`,
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

function sleepAsync(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Verifies all file fingerprints asynchronously (FC-203).
 * If a content/size/existence mismatch is detected on the first read,
 * yields to the event loop for `retryDelayMs` (default 150ms) without blocking
 * timers or I/O, then re-checks once to rule out transient IDE buffer flushes.
 */
export async function verifyFingerprintsWithRetry(
  workspaceRoot: string,
  fingerprints: FileFingerprint[],
  retryDelayMs: number = 150
): Promise<FingerprintVerificationResult> {
  const firstCheck = verifySingleRun(workspaceRoot, fingerprints);
  if (firstCheck.valid || firstCheck.reason === 'SECURITY_REJECTED') {
    return firstCheck;
  }

  await sleepAsync(retryDelayMs);
  return verifySingleRun(workspaceRoot, fingerprints);
}
