#!/usr/bin/env node
/**
 * SanchalanOS coding-agent runner: works a SanchalanOS backlog with Claude Code or Codex on this
 * machine, hands-free, with a person approving every change before it is committed and pushed.
 *
 *   SANCHALAN_URL=https://www.sanchalan.hrpai.in SANCHALAN_KEY=syn_… node scripts/agent/sanchalan-agent.mjs
 *
 * Environment:
 *   SANCHALAN_URL   the workspace address
 *   SANCHALAN_KEY   an API key (read + write) of the person the agent works for
 *   AGENT           claude (default) or codex
 *   WORK_DIR        where projects live (default ~/sanchalan-work); each job gets its own git worktree
 *   PROJECT         only this project (key, name or id)
 *   CLAUDE_ARGS     extra flags for `claude -p` (default: --permission-mode acceptEdits --allowedTools "Bash Read Edit Write Glob Grep")
 *   CODEX_ARGS      extra flags for `codex exec` (default: --full-auto)
 *   PR              1 (default): open a pull request with the GitHub CLI after pushing, when `gh` is installed
 *   ONCE            1: do one job and stop
 *
 * Loop: next_work → clone / create the project, a worktree on the job's branch → the agent implements and
 * tests (it must not commit) → request_review with its summary and the test results → a person approves
 * in SanchalanOS → commit, push, pull request, release command → complete. Asked-for changes come back
 * through next_work to the same worktree.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, hostname, tmpdir } from 'node:os';
import { join } from 'node:path';

const URL_ = (process.env.SANCHALAN_URL ?? '').replace(/\/$/, '');
const KEY = process.env.SANCHALAN_KEY ?? '';
const AGENT = (process.env.AGENT ?? 'claude').toLowerCase();
const WORK_DIR = (process.env.WORK_DIR ?? join(homedir(), 'sanchalan-work')).replace(/^~/, homedir());
const NAME = `${AGENT === 'codex' ? 'codex' : 'claude-code'}@${hostname()}`;
const PR = process.env.PR !== '0';
if (!URL_ || !KEY) {
  console.error('Set SANCHALAN_URL and SANCHALAN_KEY (an API key with read and write access).');
  process.exit(1);
}
mkdirSync(WORK_DIR, { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let rid = 1;
async function tool(name, args = {}) {
  const res = await fetch(`${URL_}/api/v1/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
    body: JSON.stringify({ jsonrpc: '2.0', id: rid++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j) throw new Error(`SanchalanOS answered ${res.status}: ${JSON.stringify(j?.error ?? j)}`);
  if (j.error) throw new Error(j.error.message);
  if (j.result.isError) throw new Error(j.result.content?.[0]?.text ?? 'tool failed');
  return j.result.structuredContent;
}

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const tryGit = (cwd, ...args) => {
  try {
    return git(cwd, ...args);
  } catch {
    return null;
  }
};
const has = (bin) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

/** The project's main checkout (cloned, or created when no repository is linked), and a worktree for the job. */
function workspace(job) {
  const s = job.setup;
  const base = join(WORK_DIR, s.localFolder);
  const repo = s.repos[0];
  if (!existsSync(base)) {
    if (repo) {
      log(`cloning ${repo.cloneUrl} → ${base}`);
      execFileSync('git', ['clone', repo.cloneUrl, base], { stdio: 'inherit' });
    } else {
      log(`creating a new project folder ${base}`);
      mkdirSync(base, { recursive: true });
      git(base, 'init', '-b', 'main');
      writeFileSync(join(base, 'README.md'), `# ${s.project.name}\n\nCreated for SanchalanOS project ${s.project.key ?? s.project.name}.\n`);
      git(base, 'add', '-A');
      git(base, '-c', 'user.name=SanchalanOS agent', '-c', 'user.email=agent@localhost', 'commit', '-m', 'Start the project');
    }
  }
  const def = repo?.defaultBranch ?? (tryGit(base, 'rev-parse', '--abbrev-ref', 'HEAD') || 'main');
  const remote = !!tryGit(base, 'remote', 'get-url', 'origin');
  if (remote) tryGit(base, 'fetch', 'origin');
  const branch = job.branch ?? `sanchalan/${job.item.key}-${slug(job.item.title)}`;
  const wt = join(WORK_DIR, '.jobs', job.item.key);
  if (!existsSync(wt)) {
    mkdirSync(join(WORK_DIR, '.jobs'), { recursive: true });
    const exists = tryGit(base, 'rev-parse', '--verify', branch);
    if (exists) git(base, 'worktree', 'add', wt, branch);
    else git(base, 'worktree', 'add', '-b', branch, wt, remote ? `origin/${def}` : def);
  }
  return { base, wt, branch, def, remote };
}

function prompt(job, w) {
  const s = job.setup;
  return [
    `You are working on SanchalanOS work item ${job.item.key} (${job.item.type}) in this git worktree (branch ${w.branch}).`,
    job.reason === 'changes_requested' ? `A person reviewed your earlier work and asked for changes:\n${job.reviewNote}\nMake those changes.` : '',
    'The item:',
    JSON.stringify(job.item, null, 1),
    s.instructions ? `Project instructions:\n${s.instructions}` : '',
    'Do this:',
    '1. Read the code base, then implement the item completely (code, tests, docs as the project does).',
    '2. Run the build and the tests; fix what fails.',
    '3. Do NOT commit, push or open pull requests — a person verifies the work first.',
    '4. End your reply with exactly one fenced block:',
    '```sanchalan-review',
    '{"summary": "what you changed and why (markdown)", "testReport": "commands run and results", "howToVerify": "steps for a person", "failed": false, "reason": ""}',
    '```',
    'Set "failed": true with the reason if you could not do it (unclear requirement, missing access).',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function runAgent(cwd, text) {
  return new Promise((resolve) => {
    const out = join(tmpdir(), `sanchalan-${Date.now()}.txt`);
    const shell = process.platform === 'win32';
    const args =
      AGENT === 'codex'
        ? ['exec', ...(process.env.CODEX_ARGS ?? '--full-auto').split(' ').filter(Boolean), '--output-last-message', out, text]
        : ['-p', text, '--output-format', 'text', ...(process.env.CLAUDE_ARGS ?? '--permission-mode acceptEdits --allowedTools Bash Read Edit Write Glob Grep').split(' ').filter(Boolean)];
    const p = spawn(AGENT === 'codex' ? 'codex' : 'claude', args, { cwd, shell, stdio: ['ignore', 'pipe', 'inherit'] });
    let buf = '';
    p.stdout.on('data', (d) => {
      buf += d;
      process.stdout.write(d);
    });
    p.on('close', (code) => {
      let last = buf;
      if (AGENT === 'codex' && existsSync(out)) {
        last = readFileSync(out, 'utf8');
        rmSync(out, { force: true });
      }
      resolve({ code, text: last });
    });
  });
}

function verdictOf(text) {
  const m = /```sanchalan-review\s*([\s\S]*?)```/.exec(text);
  try {
    return m ? JSON.parse(m[1]) : null;
  } catch {
    return null;
  }
}

const waiting = new Map(); // jobId → { job, w }

async function work(job) {
  log(`▶ ${job.item.key} ${job.item.title} (${job.reason})`);
  let w;
  try {
    w = workspace(job);
  } catch (e) {
    await tool('fail', { jobId: job.jobId, message: `Could not set up the project folder: ${e.message}` });
    return;
  }
  await tool('report_progress', { jobId: job.jobId, stage: 'working', message: `${NAME} is implementing it in ${w.wt}`, branch: w.branch });
  const r = await runAgent(w.wt, prompt(job, w));
  const v = verdictOf(r.text) ?? { summary: r.text.slice(-4000), testReport: '', howToVerify: '', failed: r.code !== 0, reason: r.code !== 0 ? `The agent exited with ${r.code}` : '' };
  if (v.failed) {
    await tool('fail', { jobId: job.jobId, message: v.reason || 'The agent could not finish' });
    return;
  }
  const changed = (tryGit(w.wt, 'status', '--porcelain') ?? '').split('\n').filter(Boolean).map((l) => l.slice(3));
  if (!changed.length) {
    await tool('fail', { jobId: job.jobId, message: 'The agent made no changes' });
    return;
  }
  await tool('report_progress', { jobId: job.jobId, stage: /fail/i.test(v.testReport ?? '') ? 'tests_failed' : 'tests_passed', message: (v.testReport || 'Tests run').slice(0, 7000) });
  const rv = await tool('request_review', { jobId: job.jobId, summary: v.summary || 'Implemented', branch: w.branch, testReport: v.testReport || null, howToVerify: v.howToVerify || null, changedFiles: changed.slice(0, 500) });
  log(`⏸ ${job.item.key} waits for review in SanchalanOS (worktree ${w.wt})`);
  waiting.set(job.jobId, { job, w });
  if (rv.status === 'approved') await ship(job.jobId);
}

async function ship(jobId) {
  const { job, w } = waiting.get(jobId);
  waiting.delete(jobId);
  git(w.wt, 'add', '-A');
  git(w.wt, 'commit', '-m', `${job.item.key}: ${job.item.title}\n\nImplemented by ${NAME}; reviewed in SanchalanOS.`);
  const sha = git(w.wt, 'rev-parse', 'HEAD');
  await tool('complete', { jobId, stage: 'committed', commitSha: sha, branch: w.branch });
  if (!w.remote) {
    await tool('complete', { jobId, stage: 'released', commitSha: sha, message: 'No remote repository: committed locally on the branch' });
    return;
  }
  git(w.wt, 'push', '-u', 'origin', w.branch);
  let prUrl = null;
  if (PR && has('gh') && job.setup.repos[0]?.provider === 'github') {
    try {
      prUrl = execFileSync('gh', ['pr', 'create', '--head', w.branch, '--base', w.def, '--title', `${job.item.key}: ${job.item.title}`, '--body', `SanchalanOS ${job.item.key}\n\nReviewed and approved in SanchalanOS.`], { cwd: w.wt, encoding: 'utf8' }).trim().split('\n').pop();
    } catch (e) {
      log('pull request not opened:', e.message);
    }
  }
  await tool('complete', { jobId, stage: 'pushed', commitSha: sha, prUrl, branch: w.branch });
  const rel = job.setup.releaseCommand;
  if (rel) {
    try {
      execFileSync(rel, { cwd: w.wt, shell: true, stdio: 'inherit' });
      await tool('complete', { jobId, stage: 'released', message: `Released with: ${rel}` });
    } catch (e) {
      await tool('report_progress', { jobId, stage: 'note', message: `Pushed, but the release command failed: ${e.message}` });
    }
  }
  log(`✔ ${job.item.key} ${prUrl ?? sha}`);
}

async function checkReviews() {
  for (const [jobId] of waiting) {
    const s = await tool('review_status', { jobId, waitSeconds: 0 });
    if (s.status === 'approved') await ship(jobId).catch((e) => tool('report_progress', { jobId, stage: 'note', message: `Could not commit / push: ${e.message}` }));
    else if (s.status !== 'awaiting_review') waiting.delete(jobId); // changes come back through next_work; stopped jobs end
  }
}

log(`SanchalanOS agent runner: ${NAME} → ${URL_}, projects in ${WORK_DIR}`);
for (;;) {
  try {
    await checkReviews();
    const { job } = await tool('next_work', { agent: NAME, project: process.env.PROJECT || undefined, waitSeconds: waiting.size ? 10 : 25 });
    if (job) {
      await work(job).catch(async (e) => {
        log('job failed:', e.message);
        await tool('fail', { jobId: job.jobId, message: e.message.slice(0, 4000) }).catch(() => undefined);
      });
      if (process.env.ONCE === '1' && !waiting.size) break;
    }
  } catch (e) {
    log('error:', e.message);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}
