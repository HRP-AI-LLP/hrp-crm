/**
 * The USB-token DSC signer (tools/dsc-signer) for local runs.
 *
 * `pnpm local` calls startDscSigner(): it starts `dsc_signer.py serve` in the
 * background. The signer needs only Python and the token's driver (it reaches the token through Python's
 * own ctypes), so there is nothing to install and no unsigned add-on file for an application-control
 * policy to block. Any failure only prints a hint: the app never waits for or depends on the signer.
 *
 * Also a command:  pnpm dsc pair <code>      pnpm dsc certs --pin …      pnpm dsc serve [--lib …]
 *
 * Set DSC_SIGNER=off (or pass --no-signer to pnpm local) to skip it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'tools', 'dsc-signer');
const win = process.platform === 'win32';
const tag = '\x1b[35m[dsc]\x1b[0m';

/** A Python 3.10+ that runs: the Windows launcher first (it is signed and usually allowed), then python. */
export function findPython() {
  const cands = win ? [['py', ['-3']], ['python', []], ['python3', []]] : [['python3', []], ['python', []]];
  for (const [cmd, pre] of cands) {
    const r = spawnSync(cmd, [...pre, '-c', 'import sys; print("%d.%d" % sys.version_info[:2])'], { encoding: 'utf8' });
    if (r.status !== 0 || !r.stdout) continue;
    const [maj, min] = r.stdout.trim().split('.').map(Number);
    if (maj === 3 && min >= 10) return { cmd, pre, version: `${maj}.${min}` };
  }
  return null;
}


function prefixed(stream, out) {
  let buf = '';
  stream?.on('data', (d) => {
    buf += d.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop() ?? '';
    for (const l of lines) if (l.trim()) out.write(`${tag} ${l}\n`);
  });
}

const HINT_PY = `${tag} Python 3.10+ was not found (tried ${win ? 'py -3, python, python3' : 'python3, python'}), so the USB-token signer is not running.
${tag} Needed only to sign with a DSC on a USB token; install Python from python.org, then restart.`;

/**
 * Installs (first time, or when requirements change) and starts the signer in the background.
 * Returns { stop } so the caller can end it with the app.
 */
export function startDscSigner({ skip = false } = {}) {
  let child = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    if (child?.pid && child.exitCode === null) {
      if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
  };
  if (skip || process.env.DSC_SIGNER === 'off' || !existsSync(join(DIR, 'dsc_signer.py'))) return { stop };
  const py = findPython();
  if (!py) {
    console.log(HINT_PY);
    return { stop };
  }
  const serve = () => {
    if (stopped) return;
    child = spawn(py.cmd, [...py.pre, 'dsc_signer.py', 'serve'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1', PYTHONIOENCODING: 'utf-8' } });
    prefixed(child.stdout, process.stdout);
    prefixed(child.stderr, process.stderr);
    child.on('error', (e) => console.log(`${tag} could not start the signer: ${e.message}`));
    const started = Date.now();
    let tail = '';
    child.stderr?.on('data', (d) => (tail = (tail + d.toString()).slice(-600)));
    child.on('exit', (code) => {
      if (stopped) return;
      if (/Port \d+ is in use/.test(tail)) return console.log(`${tag} another signer is already running on that port; that one is used`);
      // a crash right after starting would only repeat: say so plainly; a later one gets restarted
      const early = Date.now() - started < 15_000;
      restarts++;
      if (early && restarts > 2) {
        console.log(`\x1b[41m\x1b[37m${tag} THE DSC SIGNER STOPPED (exit code ${code}) - USB-token signing is off.\x1b[0m See the [dsc] lines above, or run it on its own to see why:  pnpm dsc serve`);
        return;
      }
      console.log(`${tag} the signer stopped (exit code ${code}); starting it again in 3 s`);
      setTimeout(serve, 3000);
    });
  };
  let restarts = 0;
  serve();
  return { stop };
}

// run as a command: pnpm dsc <install|pair|serve|certs> …
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (win ? self.toLowerCase() === process.argv[1].toLowerCase() : self === process.argv[1])) {
  const [sub, ...rest] = process.argv.slice(2);
  // on the development computer the app runs at these addresses: pair with all of them unless told otherwise
  if (sub === 'pair' && !rest.includes('--origin')) for (const o of ['http://localhost:5173', 'http://localhost:8787', 'http://127.0.0.1:5173', 'http://127.0.0.1:8787']) rest.push('--origin', o);
  const py = findPython();
  if (!py) {
    console.error(HINT_PY);
    process.exit(1);
  }
  if (!sub || sub === 'install') {
    console.log('The signer needs no packages: only Python and the token driver. Start it with: pnpm dsc serve');
    process.exit(0);
  }
  const r = spawnSync(py.cmd, [...py.pre, 'dsc_signer.py', sub, ...rest], { cwd: DIR, stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
  process.exit(r.status ?? 1);
}
