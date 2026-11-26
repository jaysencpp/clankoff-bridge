// The bridge client: lets a Clankoff site play turns with the AI CLIs on this machine.
// It connects out to the server (nothing listens here), says which CLIs it has, then runs each turn the server sends,
// with the hardened CLI runner in agents.js (tools off, empty temp folder, API keys withheld), and sends back the
// reply. A turn the server cancels (the game was stopped) kills the CLI. The protocol is in README.md.

const MAX_TURN_MS = 900_000;
const MODEL_RE = /^(?!-)[\w.:/@-]{0,100}$/; // a model name, never something a CLI could read as a flag
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** The server's base URL, or an Error: https only (the token travels in a header), plain http just for this machine. */
export function serverBase(server) {
  let url;
  try { url = new URL(server); } catch { return new Error(`"${server}" is not a URL (expected https://…)`); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname))) {
    return new Error(`refusing ${url.protocol}//${url.host}: the bridge token would travel unencrypted. Use the site's https:// address`);
  }
  return url.origin + url.pathname.replace(/\/+$/, '');
}

// What the server is told when a turn fails. The site shows it to everyone watching the game, so it names the kind of
// failure and never repeats the CLI's own output, which can mention folders or accounts on this machine. The full
// message stays in the log here. [what the error says, what the server hears, whether retrying the next turn is pointless]
const FAILURES = [
  [/refusing a prompt/i, 'got a prompt that starts with "-" and refused it', true],
  [/timed out/i, 'timed out', false],
  [/not logged in|please run \/login|invalid api key|\b401\b|unauthorized|no gh token/i, 'is not logged in on the bridge machine', true],
  [/issue with the selected model|recognize the model|unknown model|model\b.{0,40}\b(not found|not supported|not available|does not exist)/i, 'does not have that model', true],
  [/out of credits|insufficient[_ ]quota|exceeded your (current )?quota|billing|usage limit/i, 'is out of credits or over its usage limit', true],
  [/rate.?limit|\b429\b|overloaded/i, 'was rate limited', false],
  [/ENOENT/, 'is not installed on the bridge machine', true],
];
export function publicError(agent, e) {
  const text = String(e?.message || '');
  const hit = FAILURES.find(([re]) => re.test(text));
  return hit ? { message: `${agent} ${hit[1]}`, fatal: hit[2] || !!e?.fatal }
    : { message: `${agent} failed on the bridge machine (the bridge's own log says why)`, fatal: !!e?.fatal };
}

/**
 * @param {object} o
 * @param {string} o.server          the site's URL, e.g. https://clankoff.example.workers.dev
 * @param {string} o.token           a bridge token from the Account page
 * @param {object} o.agents          agent definitions by CLI id (providers/cli cliAgents(), or fakes in tests)
 * @param {(line: string) => void} [o.log]
 * @param {number} [o.maxConcurrent] turns run at once; more wait their turn
 * @param {string} [o.client]        name@version, told to the server
 * @returns {{ready: Promise<string>, close(): void}}  ready resolves with the account name once the server welcomes it
 */
export function startBridge({ server, token, agents, log = (line) => console.log(line), maxConcurrent = 2, client = 'clankoff-bridge' }) {
  const base = serverBase(String(server || ''));
  if (base instanceof Error) {
    const ready = Promise.reject(base);
    ready.catch(() => {});
    return { ready, close() {} };
  }
  let ws = null;
  let closed = false;
  let retry = 1000;
  const running = new Map(); // turn id -> AbortController
  const queue = [];
  let readyResolve;
  let readyReject;
  const ready = new Promise((res, rej) => { readyResolve = res; readyReject = rej; });
  ready.catch(() => {});

  const send = (msg) => { try { ws?.send(JSON.stringify(msg)); } catch { /* reconnecting */ } };

  /** The CLIs this machine has, with the models each reports. */
  async function hello() {
    const out = {};
    for (const [id, a] of Object.entries(agents)) {
      if (a.available && !a.available()) continue;
      let models = (a.models || []).filter(Boolean);
      if (a.discoverModels) {
        try { models = [...new Set([...models, ...await a.discoverModels()])]; } catch { /* keep the static list */ }
      }
      out[id] = { models: models.filter((m) => MODEL_RE.test(m)) };
    }
    return out;
  }

  async function runTurn(t) {
    const a = Object.hasOwn(agents, t.agent) ? agents[t.agent] : null;
    if (!a || (a.available && !a.available())) return send({ type: 'error', id: t.id, message: `no ${t.agent} CLI on this machine`, fatal: true });
    const model = String(t.model || '');
    const effort = String(t.effort || '');
    if (!MODEL_RE.test(model)) return send({ type: 'error', id: t.id, message: `refusing model name "${model.slice(0, 40)}"`, fatal: true });
    if (effort && !(a.efforts || []).includes(effort)) return send({ type: 'error', id: t.id, message: `${t.agent} has no effort "${effort.slice(0, 20)}"`, fatal: true });
    const ctl = new AbortController();
    running.set(t.id, ctl);
    const t0 = Date.now();
    log(`→ ${t.agent}${model ? ` ${model}` : ''}${effort ? ` [${effort}]` : ''}: turn ${t.id.slice(0, 8)}`);
    try {
      const text = await a.call({ prompt: String(t.prompt || ''), model, effort, timeoutMs: Math.min(Number(t.timeoutMs) || MAX_TURN_MS, MAX_TURN_MS), signal: ctl.signal });
      send({ type: 'reply', id: t.id, text });
      log(`← ${t.agent} answered in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    } catch (e) {
      if (!ctl.signal.aborted) send({ type: 'error', id: t.id, ...publicError(t.agent, e) });
      log(`× ${t.agent}: ${ctl.signal.aborted ? 'stopped by the server' : e.message}`);
    } finally {
      running.delete(t.id);
      pump();
    }
  }
  function pump() {
    while (running.size < maxConcurrent && queue.length) runTurn(queue.shift());
  }

  function connect() {
    const sock = new WebSocket(`${base.replace(/^http/, 'ws')}/api/bridge/connect`, { headers: { Authorization: `Bearer ${token}` } });
    ws = sock;
    sock.onopen = async () => {
      retry = 1000;
      const list = await hello();
      log(`connected to ${base}; offering ${Object.keys(list).join(', ') || 'no CLIs'}`);
      send({ type: 'hello', client, agents: list });
    };
    sock.onmessage = (m) => {
      if (m.data === 'pong') return;
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.type === 'welcome') readyResolve(msg.name);
      else if (msg.type === 'turn' && typeof msg.id === 'string') { queue.push(msg); pump(); }
      else if (msg.type === 'cancel') {
        running.get(msg.id)?.abort();
        const i = queue.findIndex((t) => t.id === msg.id);
        if (i >= 0) queue.splice(i, 1);
      }
    };
    const ping = setInterval(() => sock.readyState === WebSocket.OPEN && sock.send('ping'), 30_000);
    sock.onclose = (e) => {
      clearInterval(ping);
      for (const ctl of running.values()) ctl.abort(); // the server already failed these turns
      if (closed || ws !== sock) return;
      if (e.code === 4001) { log('the server revoked this bridge token; stopping'); closed = true; readyReject(new Error('token revoked')); return; }
      if (e.code === 4000) { log('another bridge connected for this account; stopping'); closed = true; return; }
      log(`disconnected; reconnecting in ${Math.round(retry / 1000)}s`);
      setTimeout(() => !closed && connect(), retry);
      retry = Math.min(retry * 2, 30_000);
    };
    sock.onerror = () => {};
  }

  // Check the token over plain HTTP first: a refused WebSocket gives no reason.
  fetch(`${base}/api/bridge/whoami`, { headers: { Authorization: `Bearer ${token}` } })
    .then(async (r) => {
      if (r.status === 401) throw new Error('the server doesn\'t know this bridge token (revoked, or for another site?)');
      if (!r.ok) throw new Error(`the server answered ${r.status}`);
      log(`bridge token belongs to ${(await r.json()).name}`);
      connect();
    })
    .catch((e) => { closed = true; readyReject(e); });

  return {
    ready,
    close() {
      closed = true;
      for (const ctl of running.values()) ctl.abort();
      try { ws?.close(1000, 'bridge stopped'); } catch { /* gone */ }
    },
  };
}
