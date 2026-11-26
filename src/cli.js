#!/usr/bin/env node
// clankoff-bridge: play turns for a Clankoff site with the AI CLIs installed on this machine. See README.md.
//
//   npx clankoff-bridge [--server https://…] [--agents claude,codex] [--max 2]
//
// The token comes from CLANKOFF_BRIDGE_TOKEN (environment, or a .env file in the current folder), never the command
// line, where other users of this machine could see it. --server can also be CLANKOFF_SERVER.
// Each turn runs a CLI with its tools off, in a fresh empty folder, without API keys or this token (src/agents.js).
import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { cliAgents } from './agents.js';
import { startBridge } from './client.js';

// .env in the current folder, if there is one (variables already set win)
try { process.loadEnvFile(); } catch { /* none */ }
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const { values } = parseArgs({
  options: {
    server: { type: 'string' },
    agents: { type: 'string' },
    max: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});
const usage = `clankoff-bridge ${version}
usage: npx clankoff-bridge [--server https://your-clankoff.example] [--agents claude,codex] [--max 2]
  The token is read from CLANKOFF_BRIDGE_TOKEN (environment or ./.env); make one on the site's Account page.`;
if (values.help) { console.log(usage); process.exit(0); }
if (values.version) { console.log(version); process.exit(0); }
const server = values.server || process.env.CLANKOFF_SERVER;
const token = process.env.CLANKOFF_BRIDGE_TOKEN;
if (!server || !token) {
  console.error(`${!server ? 'No server given. ' : ''}${!token ? 'CLANKOFF_BRIDGE_TOKEN is not set (make one on the Account page). ' : ''}\n${usage}`);
  process.exit(2);
}

let agents = cliAgents();
if (values.agents) {
  const wanted = new Set(values.agents.split(',').map((s) => s.trim()));
  agents = Object.fromEntries(Object.entries(agents).filter(([id]) => wanted.has(id)));
}
const stamp = () => new Date().toLocaleTimeString();
const bridge = startBridge({ server, token, agents, client: `clankoff-bridge@${version}`, maxConcurrent: Math.max(1, Number(values.max) || 2), log: (line) => console.log(`${stamp()}  ${line}`) });
bridge.ready.then((name) => console.log(`${stamp()}  ready: games on ${server} can now use your CLIs as ${name}. Ctrl-C to stop.`))
  .catch((e) => { console.error(`${stamp()}  bridge stopped: ${e.message}`); process.exit(1); });
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => { bridge.close(); process.exit(0); });
