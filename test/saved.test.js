// The remembered site and token (src/saved.js): one file only its owner can read, and the tidying of a pasted token.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { cleanToken, forget, looksLikeToken, readSaved, save, savedPath } from '../src/saved.js';

const unix = process.platform !== 'win32';
const mode = (path) => statSync(path).mode & 0o777;
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), 'clankoff-bridge-saved-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('where it is kept', { skip: !unix }, () => {
  assert.equal(savedPath({ XDG_CONFIG_HOME: '/somewhere/config' }), '/somewhere/config/clankoff-bridge/config.json');
  assert.equal(savedPath({}), join(homedir(), '.config', 'clankoff-bridge', 'config.json'));
  assert.equal(savedPath({ APPDATA: 'C:\\Users\\ada\\AppData\\Roaming' }), join(homedir(), '.config', 'clankoff-bridge', 'config.json'), 'APPDATA only counts on Windows');
});

test('save, read back, forget', (t) => {
  const path = join(scratch(t), 'clankoff-bridge', 'config.json');
  assert.equal(readSaved(path), null, 'nothing saved yet');
  save({ server: 'https://clankoff.example', token: 'clk_bridge_abc' }, path);
  assert.deepEqual(readSaved(path), { server: 'https://clankoff.example', token: 'clk_bridge_abc' });
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), { server: 'https://clankoff.example', token: 'clk_bridge_abc' }, 'nothing else is written');
  save({ server: 'https://other.example', token: 'clk_bridge_def' }, path);
  assert.deepEqual(readSaved(path), { server: 'https://other.example', token: 'clk_bridge_def' }, 'a new save replaces the old');
  forget(path);
  assert.ok(!existsSync(path));
  assert.equal(readSaved(path), null);
  forget(path); // nothing to forget is fine
});

test('only the owner can read the file', { skip: !unix }, (t) => {
  const path = join(scratch(t), 'clankoff-bridge', 'config.json');
  save({ server: 'https://clankoff.example', token: 'clk_bridge_abc' }, path);
  assert.equal(mode(path), 0o600);
  assert.equal(mode(dirname(path)), 0o700);
  // a file that was already there, readable by everyone, is closed too
  chmodSync(path, 0o644);
  save({ server: 'https://clankoff.example', token: 'clk_bridge_def' }, path);
  assert.equal(mode(path), 0o600);
});

test('a file that isn\'t one of ours reads as nothing saved', (t) => {
  const path = join(scratch(t), 'config.json');
  for (const content of ['', 'not json', 'null', '[]', '{}', '{"server":"https://x.example"}', '{"server":1,"token":2}']) {
    writeFileSync(path, content);
    assert.equal(readSaved(path), null, content || '(empty)');
  }
});

test('a pasted token is tidied', () => {
  assert.equal(cleanToken('  clk_bridge_abc \n'), 'clk_bridge_abc');
  assert.equal(cleanToken('"clk_bridge_abc"'), 'clk_bridge_abc');
  assert.equal(cleanToken('\'clk_bridge_abc\''), 'clk_bridge_abc');
  assert.equal(cleanToken('CLANKOFF_BRIDGE_TOKEN=clk_bridge_abc'), 'clk_bridge_abc', 'a whole .env line');
  assert.equal(cleanToken('CLANKOFF_BRIDGE_TOKEN = "clk_bridge_abc"'), 'clk_bridge_abc');
  assert.equal(cleanToken(undefined), '');
  assert.equal(cleanToken(''), '');
});

test('what looks like a token', () => {
  assert.ok(looksLikeToken('clk_bridge_abc-DEF_123'));
  for (const no of ['', 'clk_bridge_', 'sk-ant-abc', 'clk_bridge_abc def', 'clk_bridge_abc\n--flag', ' clk_bridge_abc']) {
    assert.ok(!looksLikeToken(no), JSON.stringify(no));
  }
});
