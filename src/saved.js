// The site and token the bridge was given, remembered between runs so it asks only once: one small JSON file in your
// config folder that only your user can read. Also the question itself, asked in the terminal the first time.
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Where it is kept: ~/.config/clankoff-bridge/config.json (XDG_CONFIG_HOME if set; %APPDATA% on Windows). */
export function savedPath(env = process.env) {
  const dir = env.XDG_CONFIG_HOME || (process.platform === 'win32' && env.APPDATA) || join(homedir(), '.config');
  return join(dir, 'clankoff-bridge', 'config.json');
}

/** What was saved, or null (no file, or not one of ours). */
export function readSaved(path = savedPath()) {
  try {
    const { server, token } = JSON.parse(readFileSync(path, 'utf8'));
    return typeof server === 'string' && typeof token === 'string' ? { server, token } : null;
  } catch { return null; }
}

export function save({ server, token }, path = savedPath()) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ server, token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600); // the mode above only counts for a new file
}

export function forget(path = savedPath()) {
  rmSync(path, { force: true });
}

/** A pasted token, tidied: spaces and quotes off, and the `CLANKOFF_BRIDGE_TOKEN=` in front if a whole .env line was pasted. */
export function cleanToken(text) {
  return String(text || '').trim().replace(/^CLANKOFF_BRIDGE_TOKEN\s*=\s*/, '').replace(/^["']|["']$/g, '').trim();
}
export const looksLikeToken = (token) => /^clk_bridge_[\w-]+$/.test(token);

/** Ask for the token in the terminal. What is typed or pasted isn't shown, so it stays out of the scrollback. */
export function askToken(question) {
  return new Promise((resolve) => {
    let hide = false;
    const output = new Writable({ write(chunk, enc, done) { if (!hide) process.stdout.write(chunk, enc); done(); } });
    const rl = createInterface({ input: process.stdin, output, terminal: true });
    rl.on('SIGINT', () => { process.stdout.write('\n'); process.exit(130); });
    rl.on('close', () => resolve('')); // Ctrl-D; after an answer this does nothing
    rl.question(question, (answer) => { process.stdout.write('\n'); resolve(cleanToken(answer)); rl.close(); });
    hide = true; // the question is written; nothing after it is
  });
}
