// Connecting with a click in the browser (src/pair.js): the site gets the token's hash and never the token, until
// it says the link was approved.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { openBrowser, startPairing, waitForApproval } from '../src/pair.js';
import { fakeSite } from './fake-site.js';

/** A site whose POST /api/bridge/pair answers `answer`. Stopped when the test ends. */
async function siteAnswering(t, answer) {
  const site = await fakeSite({ pair: () => answer });
  t.after(() => site.stop());
  return site;
}

test('startPairing sends the token\'s hash and builds the link from the code', async (t) => {
  const site = await siteAnswering(t, { body: { code: 'ABCD-2345', expiresIn: 300 } });
  const p = await startPairing(site.url);
  assert.match(p.token, /^clk_bridge_[\w-]{32}$/, 'a fresh random token');
  assert.deepEqual(site.pairings, [{ tokenHash: createHash('sha256').update(p.token).digest('hex') }], 'only the hash is sent');
  assert.equal(p.code, 'ABCD-2345');
  assert.equal(p.url, `${site.url}/account#pair=ABCD-2345`);
  assert.equal(p.expiresIn, 300);
  assert.notEqual((await startPairing(site.url)).token, p.token, 'a new token every time');
});

test('how long the link lasts is kept within sensible bounds', async (t) => {
  for (const [sent, kept] of [[undefined, 600], [1, 30], [86_400, 3600], ['soon', 600]]) {
    const site = await siteAnswering(t, { body: { code: 'ABCD-2345', expiresIn: sent } });
    assert.equal((await startPairing(site.url)).expiresIn, kept, `expiresIn ${sent}`);
  }
});

test('only a code goes into the link', async (t) => {
  for (const code of ['abcd-2345', 'ABCD-2345&next=https://evil.example', 'ABCD2345', '', undefined, { a: 1 }]) {
    const site = await siteAnswering(t, { body: { code } });
    await assert.rejects(startPairing(site.url), (e) => e.status === 200 && /doesn't understand/.test(e.message), `code ${JSON.stringify(code)}`);
  }
});

test('a site that can\'t pair says so with a status; one that can\'t be reached has none', async (t) => {
  const old = await siteAnswering(t, { status: 404, body: { error: 'Not found' } });
  await assert.rejects(startPairing(old.url), (e) => e.status === 404 && e.message === 'Not found');
  const busy = await siteAnswering(t, { status: 429, body: {} });
  await assert.rejects(startPairing(busy.url), (e) => e.status === 429 && e.message === 'the site answered 429');
  const down = await fakeSite();
  await down.stop();
  await assert.rejects(startPairing(down.url), (e) => e.status === undefined);
});

test('waitForApproval asks until the link is approved', async (t) => {
  const site = await fakeSite();
  t.after(() => site.stop());
  const token = 'clk_bridge_waiting';
  site.pending.add(token);
  setTimeout(() => site.tokens.set(token, 'Ada'), 60);
  assert.equal(await waitForApproval(site.url, { token, expiresIn: 5 }, { every: 10 }), 'Ada');
  assert.ok(site.whoami.length >= 2, 'it asked more than once');
  assert.ok(site.whoami.every((h) => h === `Bearer ${token}`), 'the token is sent in a header');
});

test('waitForApproval stops when the link is declined or runs out', async (t) => {
  const site = await fakeSite();
  t.after(() => site.stop());
  // declined (or expired on the site): the token is simply unknown
  await assert.rejects(waitForApproval(site.url, { token: 'clk_bridge_declined', expiresIn: 5 }, { every: 10 }), /declined on the site, or the link ran out/);
  // never clicked
  site.pending.add('clk_bridge_ignored');
  await assert.rejects(waitForApproval(site.url, { token: 'clk_bridge_ignored', expiresIn: 0.1 }, { every: 10 }), /ran out before anyone clicked/);
});

test('waitForApproval keeps waiting through a moment offline', async (t) => {
  const site = await fakeSite();
  const url = site.url;
  await site.stop();
  await assert.rejects(waitForApproval(url, { token: 'clk_bridge_offline', expiresIn: 0.1 }, { every: 10 }), /ran out before anyone clicked/, 'a failed request is not a refusal');
});

test('no browser is opened on a machine without a desktop', () => {
  assert.equal(openBrowser('https://clankoff.example/account#pair=ABCD-2345', { platform: 'linux', env: {} }), false);
  assert.equal(openBrowser('https://clankoff.example/account#pair=ABCD-2345', { platform: 'freebsd', env: {} }), false);
});
