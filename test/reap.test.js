// Agent CLIs (e.g. Codex via codex-linux-sandbox) can leave tool commands running after they exit.
// reapTree (src/reap.js) must catch those: same process group, descendants, or anything still working in the scratch
// folder. The lookups need /proc, so these run on Linux only.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { cliAgent } from '../src/agents.js';
import { reapTree } from '../src/reap.js';

const skip = existsSync('/proc/self/stat') ? false : 'no /proc on this system';
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Run `script` as the "agent" (it prints the pids of its strays), reap it, and check that none is left. */
async function scenario(script, { waitForExit }) {
  const dir = mkdtempSync(join(tmpdir(), 'clankoff-reap-test-'));
  const child = spawn('sh', ['-c', script], { cwd: dir, detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  // 'exit', not 'close': an escaped grandchild keeps the stdout pipe open, so 'close' would never fire.
  const exited = new Promise((r) => child.on('exit', r));
  await wait(300);
  if (waitForExit) await exited;
  const strays = out.trim().split(/\s+/).filter(Boolean).map(Number);
  try {
    assert.ok(strays.length, 'test setup printed no pids');
    assert.ok(strays.every(alive), 'strays should be running before the reap');
    const signalled = reapTree({ pid: child.pid, dir, graceMs: 200 });
    for (const pid of strays) assert.ok(signalled.includes(pid), `pid ${pid} was found`);
    assert.ok(!signalled.includes(process.pid), 'never this process');
    await wait(600);
    for (const pid of strays) assert.ok(!alive(pid), `pid ${pid} survived the reap`);
  } finally {
    for (const pid of strays) try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

// Agent killed mid-run (timeout/abort): child and a grandchild in the same group.
test('a timeout kills the whole process group', { skip }, () =>
  scenario('sleep 300 & echo $!; echo $$; wait', { waitForExit: false }));

// Agent exits cleanly but its tool command escaped into its own session and was reparented to init.
test('an orphan in its own session is found by its working folder', { skip }, () =>
  scenario('setsid sleep 300 & echo $!; exit 0', { waitForExit: true }));

// A process that ignores SIGTERM is SIGKILLed after the grace period.
test('a stray that ignores SIGTERM gets SIGKILL', { skip }, () =>
  scenario('setsid sh -c \'trap "" TERM; echo $$; while :; do sleep 1; done\' & sleep 0.1; exit 0', { waitForExit: true }));

test('nothing to reap is fine', { skip }, () => {
  assert.deepEqual(reapTree({ pid: 0, dir: join(tmpdir(), 'clankoff-no-such-folder') }), []);
});

// End to end through the runner: a fake CLI starts a stray in its own session that holds stdout open (like Codex's
// sandboxed `node -e` solver), prints an answer and exits 0.
test('a run reaps strays after a clean exit, and doesn\'t wait for them', { skip }, async () => {
  const fake = cliAgent('fake', { bin: 'sh', build: () => ({ args: ['-c', 'setsid sleep 300 & echo "stray $!"; echo answer; exit 0'] }) });
  const t0 = Date.now();
  const reply = await fake.call({ prompt: '', timeoutMs: 20_000 });
  const stray = Number(reply.match(/stray (\d+)/)[1]);
  assert.match(reply, /answer/);
  assert.ok(Date.now() - t0 < 5000, 'the run should not wait for the stray to release stdout');
  await wait(300);
  assert.ok(!alive(stray), `the run left stray pid ${stray} running`);
});
