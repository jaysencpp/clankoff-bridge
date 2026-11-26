// Kill everything an agent CLI left behind. Killing only the direct child is not enough: CLIs like
// Codex run tool commands through a sandbox helper, and those grandchildren get reparented to init
// and keep running (one burned a core for hours). Linux-only lookups via /proc; elsewhere we fall
// back to the process group.
import { readdirSync, readFileSync, readlinkSync } from 'node:fs';

/** Snapshot of all processes we can see: pid, parent, process group, start time (for identity), cwd. */
function listProcs() {
  const out = [];
  let names;
  try { names = readdirSync('/proc'); } catch { return null; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, 'utf8');
      // Fields after "(comm) ": state ppid pgrp ... ; starttime is field 22 overall.
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let cwd = null;
      try { cwd = readlinkSync(`/proc/${name}/cwd`).replace(/ \(deleted\)$/, ''); } catch {}
      out.push({ pid: +name, ppid: +f[1], pgid: +f[2], start: f[19], cwd });
    } catch { /* exited while we looked, or not ours */ }
  }
  return out;
}

const send = (pid, sig) => { try { process.kill(pid, sig); } catch {} };

/**
 * Terminate the process tree of an agent run: the group led by `pid`, all descendants, and any
 * process whose cwd is inside `dir` (catches orphans that escaped the group). SIGTERM first, then
 * SIGKILL after `graceMs` for anything still alive. Pass signal 'SIGKILL' to skip the grace period.
 * Returns the pids that were signalled.
 */
export function reapTree({ pid, dir, signal = 'SIGTERM', graceMs = 3000 }) {
  const procs = listProcs();
  if (!procs) { // no /proc: best effort via the process group
    if (pid) send(-pid, signal);
    return [];
  }
  const children = new Map();
  for (const p of procs) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p);
  }
  const targets = new Map();
  const add = (p) => {
    if (p.pid === process.pid || targets.has(p.pid)) return;
    targets.set(p.pid, p);
    for (const c of children.get(p.pid) || []) add(c);
  };
  const inDir = (cwd) => dir && cwd && (cwd === dir || cwd.startsWith(dir + '/'));
  for (const p of procs) if ((pid && (p.pid === pid || p.pgid === pid)) || inDir(p.cwd)) add(p);

  for (const p of targets.values()) send(p.pid, signal);
  if (signal !== 'SIGKILL' && targets.size) {
    setTimeout(() => {
      const alive = new Map((listProcs() || []).map((p) => [p.pid, p]));
      // Same pid AND same start time, so we never hit a recycled pid.
      for (const p of targets.values()) if (alive.get(p.pid)?.start === p.start) send(p.pid, 'SIGKILL');
    }, graceMs).unref();
  }
  return [...targets.keys()];
}
