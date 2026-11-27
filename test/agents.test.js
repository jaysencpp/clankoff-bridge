// The CLI runner (src/agents.js): the exact arguments each CLI is started with (tools off), what it is and isn't
// given (no API keys, no bridge token, an empty folder), and how a run ends: answered, failed, timed out, stopped.
// The runs here use `sh` as a stand-in CLI; none of the real ones is started.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliAgent, cliAgents, cliEnv, WITHHELD_VARS } from '../src/agents.js';
import { CLI_META } from '../src/meta.js';

const unix = process.platform !== 'win32';
const AGENTS = cliAgents();
const build = (id, o = {}) => AGENTS[id].build({ prompt: 'p', model: 'm', effort: '', dir: '/tmp', ...o });
const args = (id, effort) => build(id, { effort }).args.join(' ');
/** A stand-in CLI: `sh -c script`. */
const sh = (script, spec = {}) => cliAgent('fake', { bin: 'sh', build: () => ({ args: ['-c', script] }), ...spec });
const run = (agent, o = {}) => agent.call({ prompt: 'hello', timeoutMs: 10_000, ...o });
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('the four CLIs, described by meta.js', () => {
  assert.deepEqual(Object.keys(AGENTS), ['claude', 'codex', 'copilot', 'gemini']);
  assert.deepEqual(Object.keys(CLI_META), Object.keys(AGENTS));
  for (const [id, a] of Object.entries(AGENTS)) {
    assert.equal(a.label, CLI_META[id].label);
    assert.deepEqual(a.efforts, CLI_META[id].efforts);
    assert.equal(a.models[0], '', `${id}: the CLI's own default model comes first`);
    assert.equal(typeof a.available(), 'boolean');
  }
  // the site imports meta.js to check bridged lanes, so it can't need Node
  assert.doesNotMatch(readFileSync(new URL('../src/meta.js', import.meta.url), 'utf8'), /^\s*import\b|\bimport\s*\(|\brequire\s*\(|\bprocess\./m);
});

test('Claude Code: no tools, no MCP servers, the prompt on stdin', () => {
  const c = build('claude', { prompt: '--settings={}' });
  assert.deepEqual(c.args, ['-p', '--output-format', 'text', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--model', 'm']);
  assert.equal(c.stdin, '--settings={}');
  assert.ok(!c.args.includes('--settings={}'), 'the prompt is not an argument');
  assert.match(args('claude', 'max'), /--effort max$/);
  assert.doesNotMatch(args('claude', ''), /effort/);
  assert.ok(!build('claude', { model: '' }).args.includes('--model'), 'no model: the CLI\'s default');
});

test('Codex: read-only sandbox, no shell, no web search, no MCP servers, the prompt on stdin', () => {
  const dir = mkdtempSync(join(tmpdir(), 'codex-args-'));
  try {
    const c = build('codex', { dir, prompt: 'the prompt' });
    assert.deepEqual(c.args, ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--color', 'never',
      '--disable', 'shell_tool', '--disable', 'unified_exec', '-c', 'web_search="disabled"', '-c', 'mcp_servers={}',
      '-o', join(dir, 'last-message.txt'), '-m', 'm', '-']);
    assert.equal(c.stdin, 'the prompt');
    assert.match(args('codex', 'high'), /-c model_reasoning_effort="high" -$/);
    // its own catalog without the code-running tool, when one could be made
    const withCatalog = build('codex', { dir, catalog: '/tmp/models.json' }).args;
    assert.equal(withCatalog[withCatalog.indexOf('-o') - 1], 'model_catalog_json="/tmp/models.json"');
    assert.throws(() => c.readResult(), 'no answer file yet');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('Copilot: its built-in MCP servers off', () => {
  assert.deepEqual(build('copilot').args, ['-p', 'p', '-s', '--no-color', '--disable-builtin-mcps', '--model', 'm']);
  assert.match(args('copilot', 'xhigh'), /--reasoning-effort xhigh$/);
});

test('Gemini: every tool denied by an admin policy, and again by the top settings layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gemini-args-'));
  try {
    const g = build('gemini', { dir });
    const policyPath = join(dir, 'clankoff-no-tools.toml');
    assert.deepEqual(g.args, ['-p', 'p', '-e', 'none', '--admin-policy', policyPath, '-m', 'm']);
    const policy = readFileSync(policyPath, 'utf8');
    assert.match(policy, /\[\[rule\]\]\ntoolName = "\*"\ndecision = "deny"\npriority = 999/, 'every tool is denied');
    assert.match(policy, /mcpName = "\*"\ndecision = "deny"/, 'MCP tools too');
    const settings = JSON.parse(readFileSync(g.env.GEMINI_CLI_SYSTEM_SETTINGS_PATH, 'utf8'));
    assert.deepEqual(settings.policyPaths, [policyPath]);
    assert.equal(settings.security.disableYoloMode, true);
    assert.equal(settings.admin.mcp.enabled, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a CLI\'s environment has no API keys and no bridge token', () => {
  const vars = ['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
    'OPENROUTER_API_KEY', 'CLANKOFF_BRIDGE_TOKEN'];
  for (const v of vars) assert.ok(WITHHELD_VARS.has(v), `${v} is withheld`);
  const before = { ...process.env };
  try {
    for (const v of WITHHELD_VARS) process.env[v] = 'secret';
    process.env.CLAUDE_CONFIG_DIR_TEST = 'kept';
    const env = cliEnv({ EXTRA: '1' });
    for (const v of WITHHELD_VARS) assert.ok(!(v in env), `${v} is not passed to a CLI`);
    assert.equal(env.CLAUDE_CONFIG_DIR_TEST, 'kept', 'the rest of the environment is (the CLI\'s own login lives there)');
    assert.equal(env.EXTRA, '1');
    assert.equal(env.NO_COLOR, '1');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
});

test('a run: the answer is what the CLI printed', { skip: !unix }, async () => {
  assert.equal(await run(sh('echo answer')), 'answer\n');
  // the prompt on stdin, when build() says so
  const cat = cliAgent('fake', { bin: 'sh', build: ({ prompt }) => ({ args: ['-c', 'cat'], stdin: prompt }) });
  assert.equal(await run(cat, { prompt: 'from stdin' }), 'from stdin');
  // build() gets the turn's model and effort, and what prepare() found
  const echo = cliAgent('fake', {
    bin: 'sh',
    prepare: async () => ({ catalog: 'prepared' }),
    build: ({ model, effort, catalog }) => ({ args: ['-c', `echo "${model} ${effort} ${catalog}"`] }),
  });
  assert.equal(await run(echo, { model: 'opus', effort: 'high' }), 'opus high prepared\n');
});

test('a run: an empty folder of its own, gone afterwards', { skip: !unix }, async () => {
  const out = await run(sh('pwd; ls -A | wc -l'));
  const [dir, count] = out.trim().split('\n').map((s) => s.trim());
  assert.match(dir, /clankoff-ai-/);
  assert.notEqual(dir, process.cwd());
  assert.equal(count, '0', 'the folder is empty');
  assert.ok(!existsSync(dir), 'and removed when the turn is over');
});

test('a run: the spawned CLI sees no API key, and does see what build() and prepare() set', { skip: !unix }, async () => {
  const before = { ...process.env };
  try {
    Object.assign(process.env, { ANTHROPIC_API_KEY: 'sk-x', CLANKOFF_BRIDGE_TOKEN: 'clk_bridge_x' });
    assert.equal(await run(sh('echo "key=${ANTHROPIC_API_KEY:-none} token=${CLANKOFF_BRIDGE_TOKEN:-none}"')), 'key=none token=none\n');
    const withEnv = cliAgent('fake', {
      bin: 'sh',
      prepare: async () => ({ env: { COPILOT_GITHUB_TOKEN: 'from-prepare' } }),
      build: () => ({ args: ['-c', 'echo "s=$GEMINI_CLI_SYSTEM_SETTINGS_PATH t=$COPILOT_GITHUB_TOKEN"'], env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: '/x/settings.json' } }),
    });
    assert.equal(await run(withEnv), 's=/x/settings.json t=from-prepare\n');
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in before)) delete process.env[k];
    Object.assign(process.env, before);
  }
});

test('a prompt that starts with "-" never reaches a CLI', async () => {
  let built = 0;
  const agent = cliAgent('fake', { bin: 'sh', build: () => { built++; return { args: ['-c', 'echo ran'] }; } });
  await assert.rejects(run(agent, { prompt: '--allow-all-tools' }), (e) => e.fatal && /refusing a prompt/.test(e.message));
  await assert.rejects(AGENTS.copilot.call({ prompt: '-p', timeoutMs: 1000 }), (e) => e.fatal && /refusing a prompt/.test(e.message));
  assert.equal(built, 0);
});

test('a run that fails says how, with the CLI\'s own error lines', { skip: !unix }, async () => {
  await assert.rejects(run(sh('echo "the whole prompt, echoed"; echo "ERROR: model not found" >&2; exit 3')),
    (e) => /^fake exited with code 3: ERROR: model not found$/.test(e.message));
  // printing something is not an answer when the CLI failed
  await assert.rejects(run(sh('echo "Not logged in · Please run /login"; exit 1')), /exited with code 1: Not logged in.*is the CLI logged in/);
  // a CLI that isn't installed
  await assert.rejects(run(cliAgent('fake', { bin: 'clankoff-no-such-cli', build: () => ({ args: [] }) })), /ENOENT/);
  assert.equal(cliAgent('fake', { bin: 'clankoff-no-such-cli' }).available(), false);
  assert.equal(sh('true').available(), true);
});

test('an answer file wins over what was printed, even when the CLI exits non-zero', { skip: !unix }, async () => {
  const withFile = (script) => cliAgent('fake', {
    bin: 'sh',
    build: ({ dir }) => ({ args: ['-c', script], readResult: () => readFileSync(join(dir, 'last-message.txt'), 'utf8') }),
  });
  assert.equal(await run(withFile('echo noise; printf "the answer" > last-message.txt')), 'the answer');
  assert.equal(await run(withFile('printf "the answer" > last-message.txt; exit 1')), 'the answer');
  assert.equal(await run(withFile('echo printed')), 'printed\n', 'no file: what was printed');
  await assert.rejects(run(withFile('echo printed; exit 1')), /exited with code 1/);
});

/** A stand-in CLI that hangs, and the pid it had (written outside its own folder, which is removed). */
function hanging(t) {
  const notes = mkdtempSync(join(tmpdir(), 'clankoff-bridge-test-'));
  t.after(() => rmSync(notes, { recursive: true, force: true }));
  const pidFile = join(notes, 'pid');
  return { agent: sh(`echo $$ > ${pidFile}; exec sleep 300`), pid: () => Number(readFileSync(pidFile, 'utf8')) };
}

test('a turn that takes too long is killed', { skip: !unix }, async (t) => {
  const { agent, pid } = hanging(t);
  const t0 = Date.now();
  await assert.rejects(agent.call({ prompt: 'p', timeoutMs: 400 }), /^Error: fake timed out after 0s$/);
  assert.ok(Date.now() - t0 < 3000);
  await sleep(200);
  assert.ok(!alive(pid()), 'the CLI is gone');
});

test('a turn the server stops is killed at once', { skip: !unix }, async (t) => {
  const { agent, pid } = hanging(t);
  const ctl = new AbortController();
  const turn = run(agent, { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 200);
  const t0 = Date.now();
  await assert.rejects(turn, /^Error: aborted$/);
  assert.ok(Date.now() - t0 < 2000);
  await sleep(200);
  assert.ok(!alive(pid()), 'the CLI is gone');
  // already stopped before it started: no CLI at all
  let built = 0;
  const never = cliAgent('fake', { bin: 'sh', build: () => { built++; return { args: ['-c', 'echo ran'] }; } });
  await assert.rejects(run(never, { signal: AbortSignal.abort() }), /aborted/);
  assert.equal(built, 0);
});
