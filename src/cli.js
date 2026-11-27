#!/usr/bin/env node
// clankoff-bridge: play turns for a Clankoff site with the AI CLIs installed on this machine. See README.md.
//
//   npx clankoff-bridge [--server https://…] [--agents claude,codex] [--max 2] [--forget]
//
// The first run prints a link to the site's Account page (and opens it): sign in there and click Connect (src/pair.js).
// The bridge then remembers its token with the site's address (src/saved.js), so later runs ask nothing.
// A site that can't do that gets a token pasted in the terminal instead. CLANKOFF_BRIDGE_TOKEN and CLANKOFF_SERVER
// (environment, or a .env file in the current folder) come first if set. The token is never taken from the command
// line, where other users of this machine could see it.
// Each turn runs a CLI with its tools off, in a fresh empty folder, without API keys or this token (src/agents.js).
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { cliAgents } from './agents.js';
import { serverBase, startBridge } from './client.js';
import { openBrowser, startPairing, waitForApproval } from './pair.js';
import { askToken, forget, looksLikeToken, readSaved, save, savedPath } from './saved.js';

const DEFAULT_SERVER = 'https://clankoff.com';

// .env in the current folder, if there is one (variables already set win)
try { process.loadEnvFile(); } catch { /* none */ }
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    agents: { type: 'string' },
    max: { type: 'string' },
    forget: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});
const usage = `clankoff-bridge ${version}
usage: npx clankoff-bridge [--server https://your-clankoff.example] [--agents claude,codex] [--max 2]
  The first run prints a link: open it, sign in to the site and click Connect. The bridge then remembers its token in
  ${savedPath()}
  --server   the site to play on (default ${DEFAULT_SERVER}, or the one remembered)
  --forget   delete the remembered site and token, and stop
  Without a terminal (a service, a container), make a token on the site's Account page and set CLANKOFF_BRIDGE_TOKEN
  (and CLANKOFF_SERVER) in the environment or ./.env.`;
if (values.help) { console.log(usage); process.exit(0); }
if (values.version) { console.log(version); process.exit(0); }
if (values.forget) { forget(); console.log(`Forgot the site and token in ${savedPath()}. To switch the token off for good, revoke it on the site's Account page.`); process.exit(0); }

const saved = readSaved();
const server = serverBase(values.server || process.env.CLANKOFF_SERVER || saved?.server || DEFAULT_SERVER);
if (server instanceof Error) { console.error(`${server.message}\n${usage}`); process.exit(2); }
const canShow = process.stdout.isTTY; // someone is there to read a link
const canAsk = canShow && process.stdin.isTTY;
const stop = (line, code = 1) => { console.error(line); process.exit(code); };

/** A token for this machine: connected with a click in the browser, or pasted if the site can't do that. */
async function connect() {
  console.log(`Site: ${server}`);
  let pairing;
  try { pairing = await startPairing(server); } catch (e) {
    if (!e.status) stop(`Can't reach ${server}: ${e.cause?.message || e.message}`);
    if (!canAsk) stop(`${server} can't connect a bridge from the browser (${e.message}).\n${usage}`, 2);
    console.log(`This site can't connect a bridge from the browser right now (${e.message}).`);
    return ask();
  }
  console.log(`\nOpen this link, sign in, and click Connect (it works for ${Math.round(pairing.expiresIn / 60)} minutes):\n\n  ${pairing.url}\n\nThe page must show the code ${pairing.code}. Waiting for the click…`);
  openBrowser(pairing.url);
  try { await waitForApproval(server, pairing); } catch (e) { stop(`Not connected: ${e.message}. Run it again for a new link.`); }
  return pairing.token;
}

/** Ask until something that looks like a token is pasted. */
async function ask() {
  console.log('Make a bridge token there (Account → Bridge) and paste it here. It won\'t show as you paste.');
  for (;;) {
    const answer = await askToken('Bridge token: ');
    if (looksLikeToken(answer)) return answer;
    if (!answer) { console.error('No token entered.'); process.exit(2); }
    console.log('That isn\'t a bridge token: they start with clk_bridge_. Try again, or Ctrl-C to stop.');
  }
}

// the token: the environment's, else the one remembered for this site, else a new one connected now
let token = process.env.CLANKOFF_BRIDGE_TOKEN;
let from = 'the environment';
if (!token && saved && serverBase(saved.server) === server) { token = saved.token; from = 'saved'; }
if (!token) {
  if (!canShow) stop(`CLANKOFF_BRIDGE_TOKEN is not set, and there is no terminal to show a link in.\n${usage}`, 2);
  token = await connect();
  from = 'connected';
}

let agents = cliAgents();
if (values.agents) {
  const wanted = new Set(values.agents.split(',').map((s) => s.trim()));
  agents = Object.fromEntries(Object.entries(agents).filter(([id]) => wanted.has(id)));
}
const stamp = () => new Date().toLocaleTimeString();
let bridge;
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { bridge?.close(); process.exit(0); });
for (;;) {
  bridge = startBridge({ server, token, agents, client: `clankoff-bridge@${version}`, maxConcurrent: Math.max(1, Number(values.max) || 2), log: (line) => console.log(`${stamp()}  ${line}`) });
  try {
    const name = await bridge.ready;
    if (from === 'connected') { save({ server, token }); console.log(`${stamp()}  remembered in ${savedPath()}: next time, just run npx clankoff-bridge (--forget deletes it)`); }
    console.log(`${stamp()}  ready: games on ${server} can now use your CLIs as ${name}. Ctrl-C to stop.`);
    break;
  } catch (e) {
    console.error(`${stamp()}  bridge stopped: ${e.message}`);
    // a token the site refuses: drop it if it was the remembered one, and connect again
    if (e.code !== 'bad-token' || from === 'the environment') process.exit(1);
    if (from === 'saved') forget();
    if (!canShow) process.exit(1);
    token = await connect();
    from = 'connected';
  }
}
