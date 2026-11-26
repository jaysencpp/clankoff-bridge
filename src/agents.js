// AI CLI agents (Claude Code, Codex, Copilot, Gemini): each is run once per turn, non-interactively, with its tools
// turned off, in a fresh empty folder, and its final text answer returned. Used by the bridge (cli.js) and by
// Clankoff's local mode. Node only: it spawns processes.
import { spawn, execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { join } from 'node:path';
import { reapTree } from './reap.js';
import { CLI_META } from './meta.js';

// Variables a CLI never gets. API keys and endpoints (Claude Code would bill an ANTHROPIC_API_KEY instead of using its
// own login, or follow ANTHROPIC_BASE_URL elsewhere: to run a CLI on an API key, set that up in the CLI itself), and
// the bridge's own token, which a CLI has no use for.
export const WITHHELD_VARS = new Set([
  'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'GEMINI_BASE_URL', 'OPENROUTER_API_KEY', 'OPENROUTER_BASE_URL', 'TYPESAFE_API_KEY', 'TYPESAFE_BASE_URL', 'CLANKOFF_BRIDGE_TOKEN',
]);
/** The environment a CLI runs with: this process's, minus WITHHELD_VARS, plus `extra`. */
export function cliEnv(extra = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !WITHHELD_VARS.has(k)));
  return { ...env, NO_COLOR: '1', ...extra };
}

function which(bin) {
  try {
    return execFileSync('which', [bin], { encoding: 'utf8' }).trim() || null;
  } catch {
    return null;
  }
}

// Ask a CLI for its model list; resolves with stdout or rejects on error/timeout.
const capture = (bin, args, timeout = 8000) => new Promise((resolve, reject) =>
  execFile(bin, args, { timeout, maxBuffer: 32 * 1024 * 1024, env: cliEnv() },
    (err, stdout) => (err ? reject(err) : resolve(stdout))));

// Current Codex models are catalogued with tool_mode "code_mode_only": every tool is wrapped in a
// JavaScript `exec` tool the model can also use to compute (e.g. brute-force the cube). No feature
// flag turns that off (code_mode_host only changes where it runs), so we hand Codex a copy of its own
// catalog without tool_mode. Rebuilt every few minutes; on any failure Codex runs with its own catalog.
const CODEX_CATALOG_TTL_MS = 5 * 60_000;
let codexCatalog = null; // { at, path?, pending? }
let codexCatalogDir = null;
async function codexCatalogPath() {
  if (codexCatalog && (codexCatalog.pending || Date.now() - codexCatalog.at < CODEX_CATALOG_TTL_MS)) {
    return codexCatalog.pending || codexCatalog.path;
  }
  const entry = { at: Date.now(), path: codexCatalog?.path ?? null };
  entry.pending = capture('codex', ['debug', 'models'])
    .then((text) => {
      const catalog = JSON.parse(text);
      if (!Array.isArray(catalog.models)) throw new Error('unexpected catalog shape');
      for (const m of catalog.models) delete m.tool_mode;
      codexCatalogDir ??= mkdtempSync(join(tmpdir(), 'clankoff-codex-catalog-'));
      const path = join(codexCatalogDir, 'models.json');
      writeFileSync(path, JSON.stringify(catalog));
      return (entry.path = path);
    })
    .catch((e) => { console.error('[codex] catalog override unavailable:', e.message); return entry.path; })
    .finally(() => { entry.pending = null; entry.at = Date.now(); });
  codexCatalog = entry;
  return entry.pending;
}

/** GitHub token Copilot runs with: COPILOT_GH_USER's if set, else the active `gh` account's. */
async function copilotToken() {
  const user = process.env.COPILOT_GH_USER;
  try {
    return (await capture('gh', ['auth', 'token', '--hostname', 'github.com', ...(user ? ['--user', user] : [])])).trim();
  } catch {
    throw new Error(`copilot: no gh token${user ? ` for COPILOT_GH_USER=${user}` : ''} (run \`gh auth login\`)`);
  }
}

/** Models the account can pick in Copilot, from the Copilot API. */
async function copilotApiModels() {
  const res = await fetch('https://api.githubcopilot.com/models', {
    headers: {
      Authorization: `Bearer ${await copilotToken()}`,
      'Copilot-Integration-Id': 'copilot-developer-cli',
      'X-GitHub-Api-Version': '2025-05-01',
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const { data } = await res.json();
  if (!Array.isArray(data)) throw new Error('unexpected response shape');
  return data.filter((m) => m.model_picker_enabled && m.policy?.state !== 'disabled').map((m) => m.id);
}

const CLIS = {
  claude: {
    ...CLI_META.claude,
    bin: 'claude',
    build: ({ prompt, model, effort }) => ({
      // No tools: the model has to reason about the cube itself. --tools "" removes the built-in ones;
      // --strict-mcp-config (with no --mcp-config) keeps the MCP servers set up on this machine out too.
      // The prompt goes in on stdin: as an argument, `claude -p` reads one that starts with "-" as a flag.
      args: ['-p', '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
        ...(model ? ['--model', model] : []), ...(effort ? ['--effort', effort] : [])],
      stdin: prompt,
    }),
  },
  codex: {
    ...CLI_META.codex,
    bin: 'codex',
    // `codex debug models` dumps the model catalog as JSON; hidden entries are internal.
    discoverModels: async () => JSON.parse(await capture('codex', ['debug', 'models'])).models
      .filter((m) => m.visibility === 'list').map((m) => m.slug),
    prepare: async () => ({ catalog: await codexCatalogPath() }),
    build: ({ prompt, model, effort, dir, catalog }) => {
      const outFile = join(dir, 'last-message.txt');
      return {
        // No code execution: the model has to reason about the cube itself (and can't leave a
        // brute-force solver running). shell_tool and unified_exec are both ways to run commands;
        // the catalog override removes the JavaScript `exec` tool (see codexCatalogPath). Web search is
        // off too: no looking up solutions, and with tool_mode stripped gpt-6.2 models reject Codex's
        // `web.run` function ("reserved for use by this model") with a 400. mcp_servers={} leaves out the
        // MCP servers in the user's config.toml: their tools run outside the sandbox.
        args: ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never',
          '--disable', 'shell_tool', '--disable', 'unified_exec', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
          ...(catalog ? ['-c', `model_catalog_json=${JSON.stringify(catalog)}`] : []),
          '-o', outFile, ...(model ? ['-m', model] : []),
          ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []), '-'],
        stdin: prompt,
        readResult: () => readFileSync(outFile, 'utf8'),
      };
    },
  },
  copilot: {
    ...CLI_META.copilot,
    bin: 'copilot',
    // Copilot uses whichever `gh` account is active; COPILOT_GH_USER pins one (token fetched per run).
    prepare: async () => {
      if (!process.env.COPILOT_GH_USER) return {};
      return { env: { COPILOT_GITHUB_TOKEN: await copilotToken() } };
    },
    // The account's live model list (what Copilot's /model picker shows). `copilot help config` only
    // has a fixed example list baked into the CLI, which misses newer models; it is the fallback.
    discoverModels: async () => {
      try {
        return await copilotApiModels();
      } catch (e) {
        console.error('[copilot] model list from API failed, using `copilot help config`:', e.message);
        const text = await capture('copilot', ['help', 'config']);
        const block = text.split(/^ {2}`model`:.*$/m)[1]?.split(/^ {2}`/m)[0] || '';
        return [...block.matchAll(/^\s*- "([^"]+)"/gm)].map((m) => m[1]);
      }
    },
    build: ({ prompt, model, effort }) => ({
      // In -p mode Copilot denies every tool unless explicitly allowed; its built-in MCP servers are off as well.
      args: ['-p', prompt, '-s', '--no-color', '--disable-builtin-mcps', ...(model ? ['--model', model] : []),
        ...(effort ? ['--reasoning-effort', effort] : [])],
    }),
  },
  gemini: {
    ...CLI_META.gemini,
    bin: 'gemini',
    // No tools: the model has to reason about the game itself, and a bridge must not let a prompt reach the machine.
    // Gemini CLI has no single switch for that, so three documented controls are layered (geminicli.com, configuration
    // and policy-engine references):
    //  - a policy denying every tool ("*", built-in or MCP), loaded as an admin policy (--admin-policy), the tier that
    //    beats the user's own ~/.gemini policies; denied tools are removed from what the model is offered
    //  - the same policy again via policyPaths in a system settings file (GEMINI_CLI_SYSTEM_SETTINGS_PATH, the settings
    //    layer that overrides all others), which also turns off YOLO mode and MCP servers
    //  - -e none: no extensions
    build: ({ prompt, model, dir }) => {
      const policy = join(dir, 'clankoff-no-tools.toml');
      const settings = join(dir, 'clankoff-system-settings.json');
      writeFileSync(policy, GEMINI_DENY_ALL);
      writeFileSync(settings, JSON.stringify({ policyPaths: [policy], security: { disableYoloMode: true }, admin: { mcp: { enabled: false } } }));
      return {
        args: ['-p', prompt, '-e', 'none', '--admin-policy', policy, ...(model ? ['-m', model] : [])],
        env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings },
      };
    },
  },
};

// Gemini CLI policy (TOML) that denies every tool, built-in and MCP, at the highest priority.
const GEMINI_DENY_ALL = `# Written by Clankoff for one game turn: the model answers from the prompt alone.
[[rule]]
toolName = "*"
decision = "deny"
priority = 999
denyMessage = "Tools are disabled in Clankoff games."

[[rule]]
toolName = "*"
mcpName = "*"
decision = "deny"
priority = 999
denyMessage = "Tools are disabled in Clankoff games."
`;

/**
 * An agent definition (the shape Clankoff's agent registry uses) for a CLI. `spec`: {label, bin, models, efforts, discoverModels?,
 * prepare?() → extra (async; passed to build, e.g. Codex's catalog override, extra.env), build({prompt, model, effort, dir, ...extra})
 * → {args, stdin?, readResult?}}. `build` stays on the definition so tests can check the arguments.
 */
export function cliAgent(id, spec) {
  return {
    available: () => !!which(spec.bin),
    ...spec,
    call: ({ prompt, model, effort, timeoutMs, signal }) => {
      // A prompt is text for the model, never an option: a CLI that takes it as an argument could read "--x" as a flag.
      if (String(prompt).startsWith('-')) return Promise.reject(Object.assign(new Error(`${id}: refusing a prompt that starts with "-"`), { fatal: true }));
      return spec.prepare
        ? spec.prepare().then((extra) => spawnAgent(id, spec, { prompt, model, effort, timeoutMs, signal, extra }))
        : spawnAgent(id, spec, { prompt, model, effort, timeoutMs, signal });
    },
  };
}

/** Every CLI agent, keyed by agent id. */
export const cliAgents = () => Object.fromEntries(Object.entries(CLIS).map(([id, spec]) => [id, cliAgent(id, spec)]));

// Agent runs in flight (child -> scratch dir), so they can be killed if the server itself exits.
const active = new Map();
let exitHooked = false;
function hookExit() {
  if (exitHooked) return;
  exitHooked = true;
  process.on('exit', () => {
    for (const [child, dir] of active) {
      reapTree({ pid: child.pid, dir, signal: 'SIGKILL' });
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
    if (codexCatalogDir) try { rmSync(codexCatalogDir, { recursive: true, force: true }); } catch {}
  });
  // Without these, Ctrl-C / kill would skip the 'exit' handler (agents run in their own process group).
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(sig, () => process.exit(128 + constants.signals[sig]));
}

function spawnAgent(agent, def, { prompt, model, effort, timeoutMs, signal, extra = {} }) {
  if (signal?.aborted) return Promise.reject(new Error('aborted'));
  // Run inside an empty scratch directory so the agent has no project context to poke at.
  const dir = mkdtempSync(join(tmpdir(), 'clankoff-ai-'));
  const { args, stdin, readResult, env } = def.build({ prompt, model, effort, dir, ...extra });

  return new Promise((resolve, reject) => {
    hookExit();
    // detached: the CLI leads its own process group, so the whole tree can be signalled at once.
    const child = spawn(def.bin, args, { cwd: dir, env: cliEnv({ ...extra.env, ...env }), detached: true });
    active.set(child, dir);
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      // Always, also after a clean exit: tool commands the CLI started may still be running.
      reapTree({ pid: child.pid, dir });
      active.delete(child);
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
      fn(val);
    };
    const onAbort = () => {
      finish(reject, new Error('aborted'));
    };
    const timer = setTimeout(() => {
      finish(reject, new Error(`${agent} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort);

    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (e) => finish(reject, e));
    // A stray tool process can inherit our stdout and hold it open, so 'close' never fires.
    // Once the CLI itself has exited, give stdio a moment to drain, then kill the leftovers.
    child.on('exit', () => setTimeout(() => { if (!settled) reapTree({ pid: child.pid, dir }); }, 1000).unref());
    child.on('close', (code) => {
      if (settled) return;
      let text = stdout;
      let fromFile = false;
      if (readResult) {
        try { text = readResult(); fromFile = !!text.trim(); } catch { /* fall back to stdout */ }
      }
      // A non-zero exit is a failure even if it printed something (e.g. "Not logged in"),
      // unless the agent wrote its answer to the result file.
      if (code !== 0 && !fromFile) {
        const hint = /not logged in|please run \/login|invalid api key|\b401\b/i.test(stderr + stdout)
          ? ' (is the CLI logged in for the environment the server runs in? Check CLAUDE_CONFIG_DIR / HOME.)' : '';
        // Prefer the CLI's own error lines (Codex echoes the whole prompt before them).
        const output = stderr || stdout;
        const errorLines = [...new Set(output.split('\n').map((l) => l.trim()).filter((l) => /^(ERROR|Error)\b/.test(l)))];
        const detail = errorLines.length ? errorLines.join(' ').slice(0, 600) : output.trim().slice(-600);
        return finish(reject, new Error(`${agent} exited with code ${code}: ${detail}${hint}`));
      }
      finish(resolve, text);
    });
    if (stdin != null) child.stdin.end(stdin);
    else child.stdin.end();
  });
}
