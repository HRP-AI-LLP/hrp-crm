/**
 * The USB-token DSC signer (tools/dsc-signer) for local runs.
 *
 * `pnpm local` and `pnpm local:cloud` call startDscSigner(): in the background it installs the signer's
 * Python packages into tools/dsc-signer/.deps with `python -m pip --target` (no pip.exe or other new
 * program runs, which application-control policies often block) and starts `dsc_signer.py serve`. Any
 * failure only prints a hint: the app itself never waits for or depends on the signer.
 *
 * Also a command:  pnpm dsc pair <code> --origin http://localhost:5173 --origin http://localhost:8787
 *                  pnpm dsc certs --pin …     pnpm dsc install     pnpm dsc serve [--lib …]
 *
 * Set DSC_SIGNER=off (or pass --no-signer to pnpm local) to skip it.
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const DIR = join(ROOT, 'tools', 'dsc-signer');
const DEPS = join(DIR, '.deps');
const STAMP = join(DEPS, '.installed');
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

function stampFor(py) {
  return createHash('sha256').update(readFileSync(join(DIR, 'requirements.txt'))).update(py.version).digest('hex');
}

const installed = (py) => existsSync(STAMP) && readFileSync(STAMP, 'utf8').trim() === stampFor(py);
const pipArgs = (py) => [...py.pre, '-m', 'pip', 'install', '--disable-pip-version-check', '--no-warn-script-location', '--upgrade', '--target', DEPS, '-r', join(DIR, 'requirements.txt')];

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
    child = spawn(py.cmd, [...py.pre, 'dsc_signer.py', 'serve'], { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    prefixed(child.stdout, process.stdout);
    prefixed(child.stderr, process.stderr);
    child.on('error', (e) => console.log(`${tag} could not start the signer: ${e.message}`));
  };
  if (installed(py)) {
    serve();
  } else {
    console.log(`${tag} installing the USB-token signer's packages into tools/dsc-signer/.deps (once; Python ${py.version}) …`);
    const pip = spawn(py.cmd, pipArgs(py), { cwd: DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    pip.stderr?.on('data', (d) => (err += d.toString()));
    pip.on('error', (e) => console.log(`${tag} could not run pip: ${e.message}`));
    pip.on('exit', (code) => {
      if (code === 0) {
        writeFileSync(STAMP, stampFor(py));
        console.log(`${tag} installed`);
        serve();
      } else {
        const last = err.trim().split(/\r?\n/).slice(-3).join(`\n${tag}   `);
        console.log(`${tag} installing the signer's packages failed (the app runs; only USB-token signing is off):\n${tag}   ${last}\n${tag} Try it by hand: pnpm dsc install`);
      }
    });
  }
  return { stop };
}

// run as a command: pnpm dsc <install|pair|serve|certs> …
const self = fileURLToPath(import.meta.url);
if (process.argv[1] && (win ? self.toLowerCase() === process.argv[1].toLowerCase() : self === process.argv[1])) {
  const [sub, ...rest] = process.argv.slice(2);
  const py = findPython();
  if (!py) {
    console.error(HINT_PY);
    process.exit(1);
  }
  if (!sub || sub === 'install' || !installed(py)) {
    if (sub !== 'pair') {
      console.log(`Installing the signer's packages into tools/dsc-signer/.deps (Python ${py.version}) …`);
      const r = spawnSync(py.cmd, pipArgs(py), { cwd: DIR, stdio: 'inherit' });
      if (r.status !== 0) process.exit(r.status ?? 1);
      writeFileSync(STAMP, stampFor(py));
    }
    if (!sub || sub === 'install') process.exit(0);
  }
  const r = spawnSync(py.cmd, [...py.pre, 'dsc_signer.py', sub, ...rest], { cwd: DIR, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
