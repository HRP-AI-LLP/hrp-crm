// @ts-check
/** `pnpm local:stop` — stops a `pnpm local` that is still running (frees ports 8787 and 5173). */
import { spawnSync } from 'node:child_process';

const win = process.platform === 'win32';
for (const port of [8787, 5173]) {
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
    console.log(pids.size ? `✓ stopped what was listening on ${port}` : `· nothing on ${port}`);
  } else {
    const out = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).stdout ?? '';
    const pids = out.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), 'SIGTERM');
      } catch {
        /* gone */
      }
    }
    console.log(pids.length ? `✓ stopped what was listening on ${port}` : `· nothing on ${port}`);
  }
}
// wrangler's runtime sometimes outlives its parent on Windows
if (win) spawnSync('taskkill', ['/IM', 'workerd.exe', '/T', '/F'], { stdio: 'ignore' });
