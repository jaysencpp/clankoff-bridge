// The command itself (src/cli.js), run as a user would, against a stand-in site: where the token comes from
// (environment, ./.env, the remembered file; never the command line), and what it does without one.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { fakeSite } from './fake-site.js';

const CLI = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const TOKEN = 'clk_bridge_cli';

let site;
before(async () => { site = await fakeSite({ tokens: { [TOKEN]: 'Ada' } }); });
after(() => site.stop());

/**
 * Start the bridge in an empty folder with a config folder of its own, so nothing on this machine is read or
 * changed. No terminal: stdin and stdout are pipes. `done` resolves with {code, signal, out, err} when it exits.
 */
function bridge(t, argv = [], { env = {}, dotenv, saved } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'clankoff-bridge-cli-'));
  const cwd = join(home, 'cwd');
  const config = join(home, 'config', 'clankoff-bridge', 'config.json');
  mkdirSync(cwd);
  if (dotenv) writeFileSync(join(cwd, '.env'), dotenv);
  if (saved) { mkdirSync(join(home, 'config', 'clankoff-bridge'), { recursive: true }); writeFileSync(config, JSON.stringify(saved)); }
  // only what the bridge needs from this environment: no token or site of the person running the tests
  const base = Object.fromEntries(['PATH', 'HOME', 'USERPROFILE', 'SystemRoot', 'TMPDIR', 'TEMP'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));
  const child = spawn(process.execPath, [CLI, ...argv], { cwd, env: { ...base, XDG_CONFIG_HOME: join(home, 'config'), APPDATA: join(home, 'config'), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const run = { child, config, out: '', err: '' };
  child.stdout.on('data', (d) => { run.out += d; run.onOutput?.(); });
  child.stderr.on('data', (d) => { run.err += d; });
  run.done = new Promise((res) => child.on('close', (code, signal) => res({ code, signal, out: run.out, err: run.err })));
  /** How it ended. For a run that is expected to stop by itself: one that is still going after `ms` fails here. */
  run.exits = (ms = 15_000) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`the bridge was expected to stop, but is still running after ${ms} ms:\n${run.out}${run.err}`)), ms);
    run.done.then((r) => { clearTimeout(timer); resolve(r); });
  });
  /** Resolves once stdout has shown `re`; rejects if the bridge exits first. */
  run.shows = (re) => new Promise((resolve, reject) => {
    const check = () => re.test(run.out) && resolve(run.out);
    run.onOutput = check;
    check();
    run.done.then(({ code, out, err }) => reject(new Error(`the bridge exited (${code}) before printing ${re}:\n${out}${err}`)));
  });
  t.after(async () => { child.kill('SIGKILL'); await run.done; rmSync(home, { recursive: true, force: true }); });
  return run;
}

test('--version and --help', async (t) => {
  assert.deepEqual(await bridge(t, ['--version']).exits().then(({ code, out }) => [code, out.trim()]), [0, version]);
  const help = await bridge(t, ['--help']).exits();
  assert.equal(help.code, 0);
  assert.match(help.out, new RegExp(`^clankoff-bridge ${version.replaceAll('.', '\\.')}\\nusage: npx clankoff-bridge`));
  assert.match(help.out, /--forget/);
});

test('the token is never taken from the command line', async (t) => {
  const r = await bridge(t, ['--token', TOKEN, '--server', site.url]).exits();
  assert.notEqual(r.code, 0);
  assert.match(r.err, /Unknown option '--token'/);
});

test('a site that isn\'t https (or this machine) is refused', async (t) => {
  const r = await bridge(t, ['--server', 'http://clankoff.example'], { env: { CLANKOFF_BRIDGE_TOKEN: TOKEN } }).exits();
  assert.equal(r.code, 2);
  assert.match(r.err, /unencrypted/);
  assert.equal((await bridge(t, [], { env: { CLANKOFF_SERVER: 'not a url', CLANKOFF_BRIDGE_TOKEN: TOKEN } }).exits()).code, 2);
});

test('without a token and without a terminal, it says what to set and stops', async (t) => {
  const r = await bridge(t, ['--server', site.url]).exits();
  assert.equal(r.code, 2);
  assert.match(r.err, /CLANKOFF_BRIDGE_TOKEN is not set, and there is no terminal/);
  assert.deepEqual(site.pairings, [], 'no link was asked for: nobody could open it');
});

test('a token from the environment: connects, offers its CLIs, stops on SIGTERM', async (t) => {
  const arriving = site.connection();
  const run = bridge(t, ['--agents', 'none'], { env: { CLANKOFF_SERVER: site.url, CLANKOFF_BRIDGE_TOKEN: TOKEN } });
  const conn = await arriving;
  const hello = await conn.welcomed;
  assert.equal(conn.authorization, `Bearer ${TOKEN}`);
  assert.equal(hello.client, `clankoff-bridge@${version}`);
  assert.deepEqual(hello.agents, {}, '--agents limits what is offered');
  await run.shows(/ready: games on http:\/\/127\.0\.0\.1:\d+ can now use your CLIs as Ada/);
  assert.ok(!existsSync(run.config), 'a token from the environment is not written to disk');
  assert.ok(!run.out.includes(TOKEN), 'and never printed');
  run.child.kill('SIGTERM');
  assert.equal((await run.exits()).code, 0);
  assert.equal(await conn.closed, 1000, 'it closes the connection on its way out');
});

test('a turn for a CLI that --agents left out is refused', async (t) => {
  const arriving = site.connection();
  const run = bridge(t, ['--agents', 'none', '--server', site.url], { env: { CLANKOFF_BRIDGE_TOKEN: TOKEN } });
  const conn = await arriving;
  await run.shows(/ready:/);
  conn.send({ type: 'turn', id: 't1', agent: 'claude', prompt: 'p' });
  assert.deepEqual(await conn.next((m) => m.id === 't1'), { type: 'error', id: 't1', message: 'no claude CLI on this machine', fatal: true });
});

test('a .env file in the current folder is read', async (t) => {
  const arriving = site.connection();
  const run = bridge(t, ['--agents', 'none'], { dotenv: `CLANKOFF_SERVER=${site.url}\nCLANKOFF_BRIDGE_TOKEN=${TOKEN}\n` });
  await arriving;
  await run.shows(/ready: .* as Ada/);
});

test('the remembered site and token are used, and --server for another site does not get that token', async (t) => {
  const arriving = site.connection();
  const run = bridge(t, ['--agents', 'none'], { saved: { server: site.url, token: TOKEN } });
  assert.equal((await arriving).authorization, `Bearer ${TOKEN}`);
  await run.shows(/ready: .* as Ada/);

  const other = await fakeSite({ tokens: { [TOKEN]: 'Mallory' } });
  t.after(() => other.stop());
  const r = await bridge(t, ['--agents', 'none', '--server', other.url], { saved: { server: site.url, token: TOKEN } }).exits();
  assert.equal(r.code, 2);
  assert.match(r.err, /CLANKOFF_BRIDGE_TOKEN is not set/);
  assert.deepEqual(other.whoami, [], 'the token saved for one site is not sent to another');
});

test('a token the site refuses: the environment\'s stops the bridge, a remembered one is forgotten', async (t) => {
  const fromEnv = await bridge(t, ['--agents', 'none'], { env: { CLANKOFF_SERVER: site.url, CLANKOFF_BRIDGE_TOKEN: 'clk_bridge_revoked' } }).exits();
  assert.equal(fromEnv.code, 1);
  assert.match(fromEnv.err, /bridge stopped: the server doesn't know this bridge token/);

  const run = bridge(t, ['--agents', 'none'], { saved: { server: site.url, token: 'clk_bridge_revoked' } });
  assert.equal((await run.exits()).code, 1);
  assert.ok(!existsSync(run.config), 'the token that no longer works is deleted');
});

test('--forget deletes the remembered site and token', async (t) => {
  const run = bridge(t, ['--forget'], { saved: { server: site.url, token: TOKEN } });
  const r = await run.exits();
  assert.equal(r.code, 0);
  assert.match(r.out, /Forgot the site and token/);
  assert.ok(!existsSync(run.config));
});
