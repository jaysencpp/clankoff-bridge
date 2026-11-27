// Connecting to your account with a click in the browser, instead of a copied token.
// The bridge makes a token here and sends the site only its SHA-256, getting a short code back. You open the site's
// Account page with that code, signed in, and click Connect: the site then accepts the token this machine is holding.
// The token itself is not sent until the site says the link was approved.
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';

const CODE_RE = /^[A-Z2-9]{4}-[A-Z2-9]{4}$/;
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Ask the site for a code. Resolves with {token, code, url, expiresIn (seconds)}. An Error with `.status` means the
 * site answered but can't do this (an older site, or too many waiting); without, it couldn't be reached.
 * @param {string} base  the site's address, from serverBase()
 */
export async function startPairing(base) {
  const token = `clk_bridge_${randomBytes(24).toString('base64url')}`;
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const r = await fetch(`${base}/api/bridge/pair`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tokenHash }) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(typeof j.error === 'string' ? j.error : `the site answered ${r.status}`), { status: r.status });
  // the code goes into a link that is opened in a browser: only a code, nothing else the site might send
  if (!CODE_RE.test(j.code)) throw Object.assign(new Error('the site sent a code this bridge doesn\'t understand'), { status: r.status });
  return { token, code: j.code, url: `${base}/account#pair=${j.code}`, expiresIn: Math.max(30, Math.min(Number(j.expiresIn) || 600, 3600)) };
}

/** Wait for the click. Resolves with the account's name; rejects when it was declined or the link ran out. */
export async function waitForApproval(base, { token, expiresIn }, { every = 2000 } = {}) {
  const until = Date.now() + expiresIn * 1000;
  for (let n = 0; Date.now() < until; n++) {
    await sleep(n < 60 ? every : every * 2.5); // every 2 s for two minutes, then every 5 s
    let r;
    try { r = await fetch(`${base}/api/bridge/whoami`, { headers: { Authorization: `Bearer ${token}` } }); } catch { continue; } // offline for a moment
    const j = await r.json().catch(() => ({}));
    if (r.ok) return String(j.name || '');
    if (r.status === 401 && j.pairing !== 'pending') throw new Error('it was declined on the site, or the link ran out');
  }
  throw new Error('the link ran out before anyone clicked Connect');
}

/** Open the link in this machine's browser, if it has one. Fails silently: the link is printed too. */
export function openBrowser(url, { platform = process.platform, env = process.env } = {}) {
  if (platform !== 'darwin' && platform !== 'win32' && !env.DISPLAY && !env.WAYLAND_DISPLAY) return false; // no desktop (ssh, a server)
  const [cmd, args] = platform === 'darwin' ? ['open', [url]]
    : platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true }); // no shell: the link is one argument
    child.on('error', () => {});
    child.unref();
    return true;
  } catch { return false; }
}
