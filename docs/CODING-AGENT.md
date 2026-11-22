# Coding agent (Claude Code / Codex) over MCP

SanchalanOS hands a project's stories, tasks and bugs to Claude Code or Codex on a developer's
machine and keeps a person in the loop:

1. **Queue** — with *Project → Coding agent* switched on, an item is queued when it is created, when its
   title or description changes, or when it is reopened (types you choose). *🤖 Send to coding agent*
   on any item queues it by hand. Changes the agent makes itself never queue an item again.
2. **Claim** — the agent calls `next_work`: it gets the item (description, acceptance criteria, parent /
   epic, children, comments, links, test cases) and the project setup (repositories, local folder,
   instructions, release command). The item moves to *In progress*.
3. **Set up** — if the project is not on the machine it is cloned from the linked repository (Project →
   Work setup → Repos), or a new folder is created when no repository is linked.
4. **Implement and test** on a branch `sanchalan/<KEY>-<title>`; `report_progress` shows each step on
   the item and the job's timeline.
5. **Review** — `request_review` posts the summary, the test results and how to verify; the item moves to
   *Review* and the project manager and reporter are notified. In *Project → Coding agent* a person
   approves, requests changes (with a note — the job goes back to the agent) or stops it.
6. **Ship** — only after approval: commit, push, pull request, then the project's release command;
   `complete` records each stage, links the pull request on the item and closes it when released.
   (*Push without review* exists per project, off by default.)

## Connect

Create an API key with **read and write** access (Settings → API keys). It acts as you: the agent sees
and changes only what you can.

### Claude Code (desktop app or terminal)

```sh
claude mcp add --transport http sanchalan https://www.sanchalan.hrpai.in/api/v1/mcp \
  --header "Authorization: Bearer syn_…" --scope user
```

Then: *“Work the SanchalanOS queue: next_work, implement and test, request_review, and after approval
commit, push and complete.”*

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.sanchalan]
url = "https://www.sanchalan.hrpai.in/api/v1/mcp"
bearer_token_env_var = "SANCHALAN_KEY"
```

### Hands-free runner

`scripts/agent/sanchalan-agent.mjs` waits for work and does the loop above with `claude -p` or
`codex exec`, one git worktree per item (so several items can wait for review at once), and does the
commit / push / `gh pr create` / release itself after approval:

```sh
SANCHALAN_URL=https://www.sanchalan.hrpai.in SANCHALAN_KEY=syn_… \
WORK_DIR=~/sanchalan-work AGENT=claude node scripts/agent/sanchalan-agent.mjs
```

PowerShell:

```powershell
$env:SANCHALAN_URL="https://www.sanchalan.hrpai.in"; $env:SANCHALAN_KEY="syn_…"; $env:AGENT="claude"
node scripts/agent/sanchalan-agent.mjs
```

`AGENT=codex` for Codex, `PROJECT=FLEET` for one project, `ONCE=1` for a single job,
`CLAUDE_ARGS` / `CODEX_ARGS` to change the agent's permissions (defaults: Claude Code may edit files
and run commands in the worktree; Codex `--full-auto`). Needs git, and `gh` (signed in) for pull
requests.

## MCP tools

| Tool | What it does |
|---|---|
| `list_projects` | projects, repositories, local folder, instructions, waiting items |
| `setup_project` | how to get a project onto the machine |
| `next_work` | claims the next item (waits up to 25 s) |
| `get_work_item` | an item by key |
| `report_progress` | working / testing / tests_passed / tests_failed / note |
| `request_review` | summary, branch, tests, how to verify |
| `review_status` | awaiting_review / approved / changes_requested (+ note); waits up to 25 s |
| `complete` | committed / pushed / released (+ commit, pull request) |
| `fail` | gives the job up with the reason |
| `add_comment`, `create_work_item` | comments; files a bug or task found on the way |

Endpoint: `POST /api/v1/mcp` (JSON-RPC 2.0, Streamable HTTP with JSON responses). A job whose agent
is silent for 30 minutes goes back to the queue.
