// The bridge client (src/client.js) against a stand-in site: what it says about this machine, how it plays, refuses,
// cancels and queues turns, and what it does when the connection or the token goes.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { publicError, serverBase, startBridge } from '../src/client.js';
import { fakeSite } from './fake-site.js';

const TOKEN = 'clk_bridge_test';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noLog = () => {};

/** An agent whose turns the test finishes by hand: `calls` holds each call's options plus resolve/reject. */
function manualAgent(extra = {}) {
  const calls = [];
  const arrivals = [];
  return {
    calls,
    efforts: ['low', 'high'],
    /** Resolves with the n-th call (from 0) once it has been made. */
    called: (n) => (calls[n] ? Promise.resolve(calls[n]) : new Promise((res) => { arrivals[n] = res; })),
    call: (opts) => new Promise((resolve, reject) => {
      const c = { ...opts, resolve, reject };
      opts.signal.addEventListener('abort', () => reject(new Error('aborted')));
      calls.push(c);
      arrivals[calls.length - 1]?.(c);
    }),
    ...extra,
  };
}

let site;
before(async () => { site = await fakeSite({ tokens: { [TOKEN]: 'Ada' } }); });
after(() => site.stop());

/** A bridge connected to the site and welcomed. Closed when the test ends. */
async function connected(t, agents, opts = {}) {
  const arriving = site.connection();
  const lines = [];
  const bridge = startBridge({ server: site.url, token: TOKEN, agents, log: (l) => lines.push(l), ...opts });
  t.after(() => bridge.close());
  const conn = await arriving;
  const name = await bridge.ready;
  return { bridge, conn, name, lines };
}

test('the token only travels over https, or to this machine', async () => {
  assert.equal(serverBase('https://clankoff.example/'), 'https://clankoff.example');
  assert.equal(serverBase('https://clankoff.example/play//'), 'https://clankoff.example/play');
  assert.equal(serverBase('http://127.0.0.1:8787'), 'http://127.0.0.1:8787');
  assert.equal(serverBase('http://localhost:8787/'), 'http://localhost:8787');
  assert.equal(serverBase('http://[::1]:8787'), 'http://[::1]:8787');
  for (const bad of ['http://clankoff.example', 'http://127.0.0.1.example', 'ftp://x', 'ws://localhost', 'nope', '']) {
    assert.ok(serverBase(bad) instanceof Error, `${bad || '(empty)'} is refused`);
  }
  // nothing is sent to an address that was refused
  const bridge = startBridge({ server: 'http://clankoff.example', token: TOKEN, agents: {}, log: noLog });
  await assert.rejects(bridge.ready, /unencrypted/);
  bridge.close();
});

test('a failed turn is reported by its kind, never with the CLI\'s own output', () => {
  const leak = new Error('claude exited with code 1: Error: ENOTDIR /home/alice/.claude-work/settings.json for alice@corp.example');
  const told = publicError('claude', leak);
  assert.ok(!/alice|home|settings/.test(told.message), `nothing from the CLI's output: ${told.message}`);
  assert.equal(told.fatal, false);
  assert.deepEqual(publicError('codex', new Error('codex exited with code 1: ERROR: Not logged in. Run codex login')), { message: 'codex is not logged in on the bridge machine', fatal: true });
  assert.deepEqual(publicError('claude', new Error('claude timed out after 480s')), { message: 'claude timed out', fatal: false });
  assert.equal(publicError('copilot', new Error('copilot: no gh token for COPILOT_GH_USER=alice (run `gh auth login`)')).message, 'copilot is not logged in on the bridge machine');
  assert.deepEqual(publicError('gemini', new Error('spawn gemini ENOENT')), { message: 'gemini is not installed on the bridge machine', fatal: true });
  assert.deepEqual(publicError('claude', new Error('claude exited with code 1: API Error: 429 rate_limit_error')), { message: 'claude was rate limited', fatal: false });
  assert.deepEqual(publicError('codex', new Error('codex exited with code 1: The model `gpt-9` does not exist')), { message: 'codex does not have that model', fatal: true });
  assert.deepEqual(publicError('codex', new Error('codex exited with code 1: You exceeded your current quota')), { message: 'codex is out of credits or over its usage limit', fatal: true });
  // an error the runner marked fatal stays fatal, whatever it says
  assert.equal(publicError('claude', Object.assign(new Error('something else'), { fatal: true })).fatal, true);
  assert.equal(publicError('claude', undefined).fatal, false);
});

test('a token the site doesn\'t know stops the bridge before it connects', async () => {
  const count = site.connections.length;
  const bridge = startBridge({ server: site.url, token: 'clk_bridge_other', agents: {}, log: noLog });
  await assert.rejects(bridge.ready, (e) => e.code === 'bad-token' && /doesn't know this bridge token/.test(e.message));
  assert.equal(site.whoami.at(-1), 'Bearer clk_bridge_other', 'the token is sent in a header');
  assert.equal(site.connections.length, count, 'no WebSocket was opened');
});

test('a site that can\'t be reached, or answers with an error, rejects ready', async () => {
  const down = await fakeSite();
  await down.stop();
  await assert.rejects(startBridge({ server: down.url, token: TOKEN, agents: {}, log: noLog }).ready);
  await assert.rejects(startBridge({ server: `${site.url}/nowhere`, token: TOKEN, agents: {}, log: noLog }).ready, /the server answered 404/);
});

test('hello: the CLIs this machine has, with their models', async (t) => {
  const { conn, name, lines } = await connected(t, {
    claude: { available: () => true, models: ['', 'opus'], discoverModels: async () => ['opus', 'sonnet', '--dangerous', 'a b'], call: async () => '' },
    codex: { available: () => false, models: ['gpt'], call: async () => '' },          // not installed: not offered
    copilot: { models: ['auto'], discoverModels: async () => { throw new Error('offline'); }, call: async () => '' },
  }, { client: 'clankoff-bridge@9.9.9' });
  assert.equal(name, 'Ada');
  assert.equal(conn.authorization, `Bearer ${TOKEN}`);
  assert.equal(conn.hello.client, 'clankoff-bridge@9.9.9');
  // static and discovered models, once each; a name a CLI could read as a flag is left out; a failed lookup keeps the static list
  assert.deepEqual(conn.hello.agents, { claude: { models: ['opus', 'sonnet'] }, copilot: { models: ['auto'] } });
  assert.ok(lines.some((l) => /bridge token belongs to Ada/.test(l)));
  assert.ok(lines.some((l) => /offering claude, copilot/.test(l)));
});

test('a turn runs the CLI and sends back its answer', async (t) => {
  const agent = manualAgent();
  const { conn } = await connected(t, { claude: agent });
  conn.send({ type: 'turn', id: 'turn-1', agent: 'claude', model: 'opus', effort: 'high', prompt: 'Your move.', timeoutMs: 60_000 });
  const call = await agent.called(0);
  assert.equal(call.prompt, 'Your move.');
  assert.equal(call.model, 'opus');
  assert.equal(call.effort, 'high');
  assert.equal(call.timeoutMs, 60_000);
  call.resolve('{"move": 3}');
  assert.deepEqual(await conn.next((m) => m.id === 'turn-1'), { type: 'reply', id: 'turn-1', text: '{"move": 3}' });

  // the site can't ask for a longer turn than the bridge allows, and a missing timeout gets that limit too
  conn.send({ type: 'turn', id: 'turn-2', agent: 'claude', prompt: 'p', timeoutMs: 86_400_000 });
  conn.send({ type: 'turn', id: 'turn-3', agent: 'claude', prompt: 'p' });
  assert.equal((await agent.called(1)).timeoutMs, 900_000);
  assert.equal((await agent.called(2)).timeoutMs, 900_000);
  assert.equal(agent.calls[1].model, '');
  assert.equal(agent.calls[1].effort, '');
});

test('turns the bridge won\'t run are refused without starting a CLI', async (t) => {
  const agent = manualAgent();
  const { conn } = await connected(t, { claude: agent, codex: manualAgent({ available: () => false }) });
  const refused = async (turn, re) => {
    conn.send({ type: 'turn', prompt: 'p', ...turn });
    const m = await conn.next((x) => x.id === turn.id);
    assert.equal(m.type, 'error');
    assert.equal(m.fatal, true);
    assert.match(m.message, re);
  };
  await refused({ id: 'r1', agent: 'gemini' }, /no gemini CLI on this machine/);
  await refused({ id: 'r2', agent: 'codex' }, /no codex CLI on this machine/);
  await refused({ id: 'r3', agent: 'constructor' }, /no constructor CLI/);   // only the agents it was given
  await refused({ id: 'r4', agent: '__proto__' }, /no __proto__ CLI/);
  await refused({ id: 'r5', agent: 'claude', model: '--dangerously-skip-permissions' }, /refusing model name/);
  await refused({ id: 'r6', agent: 'claude', model: 'opus; rm -rf ~' }, /refusing model name/);
  await refused({ id: 'r7', agent: 'claude', model: 'x'.repeat(101) }, /refusing model name/);
  await refused({ id: 'r8', agent: 'claude', effort: 'turbo' }, /claude has no effort "turbo"/);
  await refused({ id: 'r9', agent: 'claude', effort: '--flag' }, /has no effort/);
  assert.equal(agent.calls.length, 0, 'no CLI was started');
  // messages that aren't turns are ignored
  conn.send('not json');
  conn.send({ type: 'turn', id: 42, agent: 'claude', prompt: 'p' });
  conn.send({ type: 'something-new' });
  conn.send({ type: 'turn', id: 'ok', agent: 'claude', prompt: 'p' });
  (await agent.called(0)).resolve('fine');
  assert.equal((await conn.next((m) => m.id === 'ok')).text, 'fine');
  assert.equal(agent.calls.length, 1);
});

test('a CLI that fails: the site hears the kind of failure, the log here keeps the detail', async (t) => {
  const agent = manualAgent();
  const { conn, lines } = await connected(t, { claude: agent });
  conn.send({ type: 'turn', id: 'f1', agent: 'claude', prompt: 'p' });
  (await agent.called(0)).reject(new Error('claude exited with code 1: Not logged in · Please run /login (/home/alice/.claude)'));
  assert.deepEqual(await conn.next((m) => m.id === 'f1'), { type: 'error', id: 'f1', message: 'claude is not logged in on the bridge machine', fatal: true });
  assert.ok(lines.some((l) => l.includes('/home/alice/.claude')), 'the full message is in the bridge\'s own log');
});

test('a cancelled turn kills the CLI and sends nothing back', async (t) => {
  const agent = manualAgent();
  const { conn } = await connected(t, { claude: agent }, { maxConcurrent: 1 });
  conn.send({ type: 'turn', id: 'c1', agent: 'claude', prompt: 'first' });
  conn.send({ type: 'turn', id: 'c2', agent: 'claude', prompt: 'second' });   // waits: one turn at a time
  conn.send({ type: 'turn', id: 'c3', agent: 'claude', prompt: 'third' });
  const first = await agent.called(0);
  await sleep(50);
  assert.equal(agent.calls.length, 1, 'the others wait their turn');
  conn.send({ type: 'cancel', id: 'c2' });   // still queued: never starts
  conn.send({ type: 'cancel', id: 'c1' });   // running: aborted
  const third = await agent.called(1);
  assert.ok(first.signal.aborted, 'the running turn was aborted');
  assert.equal(third.prompt, 'third', 'the cancelled queued turn was skipped');
  third.resolve('done');
  assert.equal((await conn.next((m) => m.id === 'c3')).text, 'done');
  await sleep(50);
  assert.deepEqual(conn.received.filter((m) => m.id === 'c1' || m.id === 'c2'), [], 'nothing is sent for a cancelled turn');
  assert.equal(agent.calls.length, 2);
});

test('turns run side by side up to the limit', async (t) => {
  const agent = manualAgent();
  const { conn } = await connected(t, { claude: agent }, { maxConcurrent: 2 });
  for (const id of ['q1', 'q2', 'q3']) conn.send({ type: 'turn', id, agent: 'claude', prompt: id });
  await agent.called(1);
  await sleep(50);
  assert.equal(agent.calls.length, 2, 'two at once, the third waits');
  agent.calls[1].resolve('b');
  assert.equal((await agent.called(2)).prompt, 'q3', 'a finished turn makes room for the next');
  agent.calls[0].resolve('a');
  agent.calls[2].resolve('c');
  assert.deepEqual(await Promise.all(['q1', 'q2', 'q3'].map((id) => conn.next((m) => m.id === id).then((m) => m.text))), ['a', 'b', 'c']);
});

test('a dropped connection: running turns stop, and the bridge connects again', async (t) => {
  const agent = manualAgent();
  const { conn, lines } = await connected(t, { claude: agent });
  conn.send({ type: 'turn', id: 'd1', agent: 'claude', prompt: 'p' });
  const call = await agent.called(0);
  const again = site.connection();
  conn.drop();
  const second = await again;   // after about a second
  assert.ok(call.signal.aborted, 'the turn the server already gave up on was stopped');
  assert.deepEqual((await second.welcomed).agents, { claude: { models: [] } }, 'it says hello again');
  assert.ok(lines.some((l) => /disconnected; reconnecting/.test(l)));
  assert.equal(second.authorization, `Bearer ${TOKEN}`);
});

test('a revoked token, or another bridge taking over, stops it for good', async (t) => {
  for (const [code, line] of [[4001, /revoked this bridge token/], [4000, /another bridge connected/]]) {
    const { conn, lines } = await connected(t, {});
    const count = site.connections.length;
    conn.close(code);
    assert.equal(await conn.closed, code);
    await sleep(1300);   // a reconnect would have come after a second
    assert.equal(site.connections.length, count, `no reconnect after ${code}`);
    assert.ok(lines.some((l) => line.test(l)), `the log says why (${code})`);
  }
});

test('close() stops running turns and closes the connection', async (t) => {
  const agent = manualAgent();
  const { bridge, conn } = await connected(t, { claude: agent });
  conn.send({ type: 'turn', id: 's1', agent: 'claude', prompt: 'p' });
  const call = await agent.called(0);
  const count = site.connections.length;
  bridge.close();
  assert.ok(call.signal.aborted);
  assert.equal(await conn.closed, 1000);
  await sleep(1300);
  assert.equal(site.connections.length, count, 'a closed bridge stays closed');
});
