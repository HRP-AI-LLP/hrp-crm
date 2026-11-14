// @ts-check
/** Frees local ports left busy by an earlier run (wrangler's workerd, Vite). */
import { spawnSync } from 'node:child_process';

const win = process.platform === 'win32';

/** @param {number[]} ports @param {boolean} [verbose] */
export function freePorts(ports, verbose = false) {
  for (const port of ports) {
    let n = 0;
    if (win) {
      const out = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).stdout ?? '';
      const pids = new Set(
        out
          .split(/\r?\n/)
          .filter((l) => /LISTENING/i.test(l) && new RegExp(`:${port}\\s`).test(l))
          .map((l) => l.trim().split(/\s+/).pop())
          .filter((p) => p && p !== '0'),
      );
      for (const pid of pids) spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      n = pids.size;
    } else {
      const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
      const pids = out.split(/\s+/).filter(Boolean);
      for (const pid of pids) {
        try {
          process.kill(Number(pid), 'SIGTERM');
        } catch {
          /* already gone */
        }
      }
      n = pids.length;
    }
    if (verbose) console.log(n ? `✓ stopped what was listening on ${port}` : `· nothing on ${port}`);
  }
}
