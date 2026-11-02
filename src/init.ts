/**
 * `ferrycat-cli init`: interactive MCP client wizard (REQ-EXP-02).
 *
 * Detects locally installed MCP hosts (Antigravity, WorkBuddy, Cursor, VS Code, Windsurf,
 * Claude Desktop, Claude Code) and merges a `ferrycat` stdio server entry into each host's
 * MCP configuration file, with a distinct AGENT_NAME per host.
 *
 * Safety rules (this command edits files owned by other applications):
 *   - Never overwrites a config it cannot parse (JSONC comments, broken JSON): the entry is
 *     printed for manual paste instead.
 *   - Never replaces an existing, different `ferrycat` entry unless --force is given.
 *   - Every existing file is backed up next to itself before the first write, and writes go
 *     through a temp file + rename so a crash cannot leave a half-written config.
 *   - Non-interactive runs without --yes only print the plan (dry run).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

export type ConfigFormat = 'mcpServers' | 'vscode';
export type ConfigScope = 'user' | 'project';

export interface McpClientSpec {
  id: string;
  label: string;
  scope: ConfigScope;
  format: ConfigFormat;
  /** Directories whose existence indicates the host is installed. */
  detectPaths: string[];
  configPath: string;
  defaultAgent: string;
}

export interface InitEnvironment {
  homeDir: string;
  cwd: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface InitOptions {
  /** Restrict to these client ids (default: all detected). */
  clients?: string[];
  /** Override AGENT_NAME for every selected client. */
  agent?: string;
  /** MCP server key inside the host config (default: "ferrycat"). */
  serverName?: string;
  /** Override config file path (requires a single --client). */
  configPath?: string;
  /** Point entry at the local dist/index.js build instead of `npx -y ferrycat`. */
  local?: boolean;
  yes?: boolean;
  dryRun?: boolean;
  force?: boolean;
  /** Only list detection results; never write. */
  list?: boolean;
  json?: boolean;
  /** Ask per client before writing (TTY only). */
  interactive?: boolean;
  environment?: Partial<InitEnvironment>;
  write?: (line: string) => void;
  prompt?: (question: string) => Promise<string>;
}

export type ClientAction =
  | 'CREATED'
  | 'UPDATED'
  | 'UNCHANGED'
  | 'CONFLICT'
  | 'UNPARSEABLE'
  | 'SKIPPED'
  | 'PLANNED'
  | 'NOT_DETECTED'
  | 'ERROR';

export interface ClientResult {
  id: string;
  label: string;
  detected: boolean;
  config_path: string;
  agent_name: string;
  action: ClientAction;
  backup_path?: string;
  message?: string;
  snippet: Record<string, unknown>;
}

export interface InitResult {
  ok: boolean;
  dry_run: boolean;
  server_name: string;
  clients: ClientResult[];
}

function resolveEnvironment(partial: Partial<InitEnvironment> = {}): InitEnvironment {
  return {
    homeDir: partial.homeDir ?? os.homedir(),
    cwd: partial.cwd ?? process.cwd(),
    platform: partial.platform ?? process.platform,
    env: partial.env ?? process.env,
  };
}

/** Per-OS application data root (where VS Code / Claude Desktop keep user settings). */
function appDataDir(e: InitEnvironment): string {
  if (e.platform === 'win32') return e.env.APPDATA ?? path.join(e.homeDir, 'AppData', 'Roaming');
  if (e.platform === 'darwin') return path.join(e.homeDir, 'Library', 'Application Support');
  return e.env.XDG_CONFIG_HOME ?? path.join(e.homeDir, '.config');
}

/**
 * Host config filenames can vary across releases (a live WorkBuddy install stores its
 * `mcpServers` map in `~/.workbuddy/.mcp.json`, while some docs reference `mcp.json`).
 * Reuse whichever candidate already exists on disk so we never write a sibling file the
 * host ignores; default to the first (canonical) candidate when none exist yet.
 */
function firstExistingConfig(dir: string, names: string[]): string {
  const hit = names.map((n) => path.join(dir, n)).find((p) => fs.existsSync(p));
  return hit ?? path.join(dir, names[0]);
}

export function buildClientRegistry(e: InitEnvironment): McpClientSpec[] {
  const home = e.homeDir;
  const appData = appDataDir(e);
  return [
    {
      id: 'antigravity',
      label: 'Google Antigravity',
      scope: 'user',
      format: 'mcpServers',
      detectPaths: [path.join(home, '.gemini', 'antigravity')],
      configPath: path.join(home, '.gemini', 'antigravity', 'mcp_config.json'),
      defaultAgent: 'antigravity',
    },
    {
      id: 'workbuddy',
      label: 'WorkBuddy',
      scope: 'user',
      format: 'mcpServers',
      detectPaths: [path.join(home, '.workbuddy')],
      configPath: firstExistingConfig(path.join(home, '.workbuddy'), ['.mcp.json', 'mcp.json']),
      defaultAgent: 'workbuddy',
    },
    {
      id: 'cursor',
      label: 'Cursor',
      scope: 'user',
      format: 'mcpServers',
      detectPaths: [path.join(home, '.cursor')],
      configPath: path.join(home, '.cursor', 'mcp.json'),
      defaultAgent: 'cursor',
    },
    {
      id: 'vscode',
      label: 'VS Code (user mcp.json)',
      scope: 'user',
      format: 'vscode',
      detectPaths: [path.join(appData, 'Code', 'User')],
      configPath: path.join(appData, 'Code', 'User', 'mcp.json'),
      defaultAgent: 'vscode',
    },
    {
      id: 'windsurf',
      label: 'Windsurf',
      scope: 'user',
      format: 'mcpServers',
      detectPaths: [path.join(home, '.codeium', 'windsurf')],
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      defaultAgent: 'windsurf',
    },
    {
      id: 'claude-desktop',
      label: 'Claude Desktop',
      scope: 'user',
      format: 'mcpServers',
      detectPaths: [path.join(appData, 'Claude')],
      configPath: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      defaultAgent: 'claude-desktop',
    },
    {
      // Claude Code's user-level ~/.claude.json holds unrelated state; only the project-scoped
      // .mcp.json in the current directory is touched.
      id: 'claude-code',
      label: 'Claude Code (project .mcp.json)',
      scope: 'project',
      format: 'mcpServers',
      detectPaths: [path.join(home, '.claude')],
      configPath: path.join(e.cwd, '.mcp.json'),
      defaultAgent: 'claude-code',
    },
  ];
}

export function buildServerEntry(
  format: ConfigFormat,
  agentName: string,
  local: boolean = false
): Record<string, unknown> {
  const localEntry = fileURLToPath(new URL('./index.js', import.meta.url));
  const base = local
    ? { command: process.execPath, args: ['--experimental-sqlite', localEntry], env: { AGENT_NAME: agentName } }
    : { command: 'npx', args: ['-y', 'ferrycat'], env: { AGENT_NAME: agentName } };
  return format === 'vscode' ? { type: 'stdio', ...base } : base;
}

function containerKey(format: ConfigFormat): 'servers' | 'mcpServers' {
  return format === 'vscode' ? 'servers' : 'mcpServers';
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Order-insensitive structural equality for small JSON values. */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    return ka.length === kb.length && ka.every((k) => k in b && jsonEqual(a[k], b[k]));
  }
  return a === b;
}

function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.ferrycat-tmp-${process.pid}`;
  fs.writeFileSync(tmp, content, 'utf8');
  try {
    fs.renameSync(tmp, file);
  } catch (err) {
    // A host holding the config open makes MoveFileEx fail with EPERM on Windows. Never leave
    // the temp file behind in the user's config directory.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* best-effort cleanup; preserve original rename error */
    }
    throw err;
  }
}

interface PlannedChange {
  action: ClientAction;
  message?: string;
  nextContent?: string;
  existed: boolean;
}

function planClient(spec: McpClientSpec, serverName: string, entry: Record<string, unknown>, force: boolean): PlannedChange {
  const key = containerKey(spec.format);
  if (!fs.existsSync(spec.configPath)) {
    const doc = { [key]: { [serverName]: entry } };
    return { action: 'CREATED', existed: false, nextContent: `${JSON.stringify(doc, null, 2)}\n` };
  }

  const raw = fs.readFileSync(spec.configPath, 'utf8').replace(/^\uFEFF/, '');
  let doc: unknown;
  if (raw.trim() === '') {
    doc = {};
  } else {
    try {
      doc = JSON.parse(raw);
    } catch (err) {
      return {
        action: 'UNPARSEABLE',
        existed: true,
        message: `Cannot parse existing config as strict JSON (comments or syntax error: ${
          err instanceof Error ? err.message : String(err)
        }). File left untouched; paste the snippet manually.`,
      };
    }
  }
  if (!isPlainObject(doc)) {
    return { action: 'UNPARSEABLE', existed: true, message: 'Existing config root is not a JSON object. File left untouched.' };
  }
  const container = doc[key];
  if (container !== undefined && !isPlainObject(container)) {
    return { action: 'UNPARSEABLE', existed: true, message: `"${key}" in existing config is not an object. File left untouched.` };
  }

  const servers = (container ?? {}) as Record<string, unknown>;
  const current = servers[serverName];
  if (current !== undefined) {
    if (jsonEqual(current, entry)) {
      return { action: 'UNCHANGED', existed: true, message: 'Entry already up to date.' };
    }
    if (!force) {
      return {
        action: 'CONFLICT',
        existed: true,
        message: `A different "${serverName}" entry already exists. Re-run with --force to replace it (a backup is written first).`,
      };
    }
  }

  const next = { ...doc, [key]: { ...servers, [serverName]: entry } };
  return {
    action: current === undefined ? 'CREATED' : 'UPDATED',
    existed: true,
    nextContent: `${JSON.stringify(next, null, 2)}\n`,
  };
}

async function defaultPrompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

export async function runInit(options: InitOptions = {}): Promise<InitResult> {
  const e = resolveEnvironment(options.environment);
  const write = options.write ?? ((line: string) => process.stdout.write(`${line}\n`));
  const say = (line = '') => {
    if (!options.json) write(line);
  };
  const serverName = options.serverName ?? 'ferrycat';
  const registry = buildClientRegistry(e);

  const knownIds = new Set(registry.map((c) => c.id));
  const requested = options.clients?.map((c) => c.trim().toLowerCase()).filter(Boolean);
  if (requested && requested.length > 0) {
    const unknown = requested.filter((c) => !knownIds.has(c));
    if (unknown.length > 0) {
      throw new Error(`Unknown --client value(s): ${unknown.join(', ')}. Supported: ${[...knownIds].join(', ')}.`);
    }
  }

  if (options.configPath) {
    if (!requested || requested.length !== 1) {
      throw new Error('--config-path requires exactly one --client <id> to be specified.');
    }
    const targetSpec = registry.find((c) => c.id === requested[0]);
    if (targetSpec) {
      targetSpec.configPath = path.resolve(e.cwd, options.configPath);
    }
  }

  const willWrite = !options.list && !options.dryRun && (options.yes || options.interactive);
  const dryRun = !willWrite;
  const results: ClientResult[] = [];

  say(`FerryCat init: MCP client setup${dryRun && !options.list ? ' (dry run: nothing will be written)' : ''}`);
  say('');

  for (const spec of registry) {
    const explicitlyRequested = requested?.includes(spec.id) ?? false;
    if (requested && requested.length > 0 && !explicitlyRequested) continue;

    const detected = spec.detectPaths.some((p) => fs.existsSync(p));
    const agentName = options.agent?.trim() || spec.defaultAgent;
    const entry = buildServerEntry(spec.format, agentName, Boolean(options.local));
    const snippet = { [containerKey(spec.format)]: { [serverName]: entry } };
    const result: ClientResult = {
      id: spec.id,
      label: spec.label,
      detected,
      config_path: spec.configPath,
      agent_name: agentName,
      action: 'NOT_DETECTED',
      snippet,
    };
    results.push(result);

    // Undetected hosts are only configured when explicitly requested via --client.
    if (!detected && !explicitlyRequested) {
      say(`  - ${spec.label}: not detected`);
      continue;
    }

    say(`  * ${spec.label}${detected ? '' : ' (not detected, explicitly requested)'}`);
    say(`      config : ${spec.configPath}`);
    say(`      agent  : AGENT_NAME=${agentName}`);

    if (options.list) {
      result.action = 'SKIPPED';
      continue;
    }

    let plan: PlannedChange;
    try {
      plan = planClient(spec, serverName, entry, Boolean(options.force));
    } catch (err) {
      result.action = 'ERROR';
      result.message = err instanceof Error ? err.message : String(err);
      say(`      result : ERROR ${result.message}`);
      continue;
    }

    if (!plan.nextContent) {
      result.action = plan.action;
      result.message = plan.message;
      say(`      result : ${plan.action}${plan.message ? ` (${plan.message})` : ''}`);
      if (plan.action === 'UNPARSEABLE' || plan.action === 'CONFLICT') {
        say('      snippet:');
        for (const line of JSON.stringify(snippet, null, 2).split('\n')) say(`        ${line}`);
      }
      continue;
    }

    if (dryRun) {
      result.action = 'PLANNED';
      result.message = `Would ${plan.action === 'UPDATED' ? 'replace' : 'add'} "${serverName}" entry.`;
      say(`      result : PLANNED (${result.message})`);
      continue;
    }

    if (options.interactive && !options.yes) {
      const prompt = options.prompt ?? defaultPrompt;
      const answer = (await prompt(`      Write ${spec.configPath}? [y/N] `)).trim().toLowerCase();
      if (answer !== 'y' && answer !== 'yes') {
        result.action = 'SKIPPED';
        say('      result : SKIPPED by user');
        continue;
      }
    }

    try {
      if (plan.existed) {
        const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const backup = `${spec.configPath}.ferrycat-bak-${suffix}`;
        fs.copyFileSync(spec.configPath, backup);
        result.backup_path = backup;
      }
      writeFileAtomic(spec.configPath, plan.nextContent);
      result.action = plan.action;
      say(`      result : ${plan.action}${result.backup_path ? ` (backup: ${result.backup_path})` : ''}`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      result.action = 'ERROR';
      result.message = result.backup_path
        ? `${errMsg} (backup preserved at ${result.backup_path})`
        : errMsg;
      say(`      result : ERROR ${result.message}`);
    }
  }

  const touched = results.filter((r) => r.action !== 'NOT_DETECTED');
  say('');
  if (touched.length === 0) {
    say('No supported MCP host detected. Use --client <id> to configure one explicitly:');
    say(`  ${registry.map((c) => c.id).join(', ')}`);
  } else if (dryRun && !options.list) {
    say('Dry run only. Re-run with --yes to apply, or run in an interactive terminal to confirm per host.');
  } else if (!options.list) {
    say('Restart (or reload MCP servers in) each updated host. Some hosts, e.g. WorkBuddy, also');
    say('require you to trust/enable the new server in their connector settings.');
    say('Next: run "npx ferrycat demo" to see a full contract lifecycle in a sandbox.');
  }

  const ok = !results.some((r) => r.action === 'ERROR');
  return { ok, dry_run: dryRun, server_name: serverName, clients: results };
}
