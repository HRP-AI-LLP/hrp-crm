# Projects and timesheets

Projects is a built-in app (Settings → Apps) in the class of Zoho Projects. It is for any business that delivers work as projects, including services, fit-out, installation, engineering and make-to-order jobs.

## Projects

- A project is a record (Projects in the menu) with:
  - customer, deal or sales order, code and dates;
  - a manager, who is the record owner;
  - a billing method: fixed price; time at a project rate, staff rates or task rates; or non-billable;
  - a budget in hours, cost or revenue;
  - the GST rate and SAC used on its invoices.
- **Team:** people are added as managers, members or viewers, each with a bill rate and a cost rate. Only managers see rates and money.
- **Use as template** (managers only): copies milestones, task lists, tasks, sub-tasks and dependencies into a new project. Dates shift to the new start date.

## Planning

- **Milestones:** phases with start and due dates, an owner and, optionally, an amount to bill.
- **Task lists and tasks:**
  - Each task has a number, assignees (project members only), start and due dates, an estimate, progress, priority, tags, billable flag and its own rate.
  - Tasks can have one level of sub-tasks. A parent cannot be closed while its sub-tasks are open.
- **Views:**
  - List, grouped by task list.
  - Board: drag cards between statuses (open, in progress, review, blocked, done).
  - Gantt chart: bars, progress, dependencies, milestones, today line and weekends, zoomable.
- **Dependencies:**
  - Types: finish-to-start, start-to-start, finish-to-finish and start-to-finish, each with a lag.
  - Circular links are refused.
  - When a task's dates move, the tasks waiting for it are pushed later; durations are kept.
- **Project progress** is the estimate-weighted share of top-level tasks done.
- **Issues:** snags, defects and bugs, with number, severity, status, assignee, reporter, related task or milestone and due date.
- **Comments** on tasks and issues.
- **Notifications** go out when:
  - someone is added to the team;
  - a task or issue is assigned;
  - a task is done or ready for review;
  - an issue is fixed or closed;
  - a comment is posted;
  - a timesheet is submitted, approved or returned.

## Time

- **Logging time:**
  - Log hours on a project's Time tab, start a timer (one at a time per person), or fill the weekly grid on **Timesheet** (Mon–Sun, one row per project and task).
  - Hours can be typed as `1.5` or `1:30`.
  - A day cannot exceed 24 hours, and time cannot be logged more than a week ahead.
- **Rates:** each entry takes its bill rate from the billing method (project, staff or task rate) and its cost rate from the person's cost rate on the project.
- **Approval:**
  - Submit the week. Managers of the projects concerned are notified and approve or return entries (with a reason) under Timesheet → Approvals.
  - Nobody approves their own time, or time they entered or changed for someone else.
  - A week is approved when all its time is, and goes back to the person if any of it is returned.
- **Locks:**
  - Submitted, approved and invoiced time cannot be edited or deleted. This is enforced in the database.
  - A project with approved time or invoices cannot be deleted.

## Billing

The project's **Billing** tab (managers) lists approved, billable, uninvoiced time, billable expenses tagged to the project, and milestones with an amount.

- Choose what to bill and add any fixed amount, such as an advance or a percentage of a fixed fee.
- Time can go on the invoice as one line per task, per person, per entry, or one line for everything.
- The result is a draft GST invoice for the project's customer, at the project's GST rate and SAC.
- Billed time, expenses and milestones are marked as invoiced so they cannot be billed twice. Deleting the draft or cancelling the invoice releases them.
- Invoices and their ledger lines carry the project, so Books can show a P&L for a project.

## Reports

- **Project overview:**
  - Progress, overdue tasks, open and critical issues.
  - Hours logged, billable and estimated; budget used; days left; hours by week.
  - For managers: invoiced, unbilled, labour cost (approved hours × cost rate), expenses and bills tagged to the project, profit and margin.
- **Timesheet → Reports:**
  - Hours by person, project, task or day, with billable share and time awaiting approval.
  - **Utilisation:** hours logged against weekly capacity (40 hours unless set per person), billable share, and open task estimates.

## Permissions

| Who | Can |
|---|---|
| `projects` admin area | Everything, including capacity settings |
| Project manager role (added when Projects is switched on) | Creates projects and runs the ones they own or are a manager of (not a workspace-wide admin) |
| Project managers (owner, or member with the manager role) | Plan, manage the team, approve time, bill, see money |
| Members | Work on tasks and issues, log their own time |
| Viewers, and people who can read the project record | Look only |
| Sales reps, operations and similar roles | See projects they own or are members of |
| Accounts and accountants | See all projects |

## API

Everything is under `/api/v1`:

- `/projects` and `/projects/:id` (`/summary`, `/members`, `/duplicate`)
- `/projects/:id/milestones`, `/lists`, `/tasks` (`/deps`, `/comments`) and `/issues`
- `/projects/:id/unbilled` and `POST /projects/:id/invoice`
- `/time`, `/time/timer/start` and `/time/timer/stop`
- `/timesheet`, `/timesheet/submit`, `/timesheet/approvals` and `/timesheet/decide`
- `/my-tasks`
- `/project-reports/time`, `/project-reports/utilisation` and `/project-reports/capacity/:userId`

## Work management (Jira / Azure DevOps style)

Every project has a **work item key** (from its code or name, e.g. `FLEET`) and items are numbered `FLEET-1`, `FLEET-2` …

- **Hierarchy**: epic → feature → story / bug / task / spike / chore → sub-task (four levels). A story or bug sits under an epic or a feature; tasks and sub-tasks under a story, bug or task. Points and progress roll up in *Epics & hierarchy*.
- **Workflows** (*Work setup*): states per work item type, each counting as a status category (to do, in progress, review, blocked, done, cancelled). Without moves defined any state goes to any state; with them, only the ticked moves are offered, optionally manager-only and needing an assignee, resolution, comment, points or estimate. Status changes made elsewhere (task list, bulk edit) follow the workflow too.
- **Components** (with a lead who can take new items) and **custom fields** per type (text, number, date, choice, multi-choice, person, checkbox, link; optionally required).
- **Boards**: kanban (open work and the last 14 days of done) or scrum (the active sprint); columns by status category or exact states, WIP limits, swimlanes (assignee, epic, parent, priority, type), quick filters and a board filter written as a query. Drag a card to move it through its workflow.
- **Queries**: `type = bug AND status != done AND assignee = currentUser() ORDER BY priority DESC`. Fields: project, key, type, status, state, assignee, reporter, watcher, priority, severity, points, estimate, remaining, sprint, release, epic, parent, component, labels, text, summary, description, resolution, created, updated, due, resolved, started and custom field keys. Operators `= != > >= < <= ~ !~ IN NOT IN IS EMPTY IS NOT EMPTY`, `AND OR NOT ( )`; functions `currentUser() openSprints() currentSprint() closedSprints() releasedVersions() unreleasedVersions() now() startOfDay() startOfWeek() startOfMonth()`; relative dates `-7d -2w -1m`. Save (private or shared), export CSV, select results for **bulk change** (status, assignee, priority, points, sprint, release, labels, component, delete). *Work items* in the menu runs queries across all your projects.
- **Item view**: workflow buttons, details, children, links between items (relates, blocks, duplicates, clones, causes, tests), comments with `@mentions`, watchers, every change in *History*, code links and covering test cases. `?item=<id>` on a project opens it.
- **Dashboards**: widgets from queries (number, breakdown, list) plus cumulative flow, cycle and lead time with weekly throughput, created vs resolved, and workload by person.
- **Test plans**: test cases with steps and expected results, linked to the stories they cover; plans for a sprint or release (add a suite or the cases covering its items); runs record pass / fail per step, and a failed run can raise a bug with the steps. *Coverage* shows which requirements have passing tests.
- **Code**: see INTEGRATIONS.md → GitHub and Azure DevOps. Mentioning a key in a branch, commit, pull request or build links it; *Work setup → Automation from code* can move the item when a branch is created, a PR opens or merges, or a build fails.

### Repositories and the code policy

Each project links its repositories (*Work setup → Code repositories*, GitHub `owner/name` or Azure DevOps `project/repo`; a repository belongs to one project). Projects without one show a **no repo** flag in the list and a banner on the project.

Per repository a policy decides what happens to a commit or pull request that names no work item (`FLEET-12`) or change request (`FLEET-CR-3`):

- **Enforce** — the CI check fails, so with branch protection (GitHub: required status check *Synapse work items / work-item*; Azure: required build validation) the PR cannot merge; the commit-msg hook refuses the commit on the developer's machine. GitHub / Azure cannot refuse the push itself from an outside service.
- **Auto-create** — Synapse creates the item from the message: `feat:` story, `fix:` bug, `epic:` epic, `cr:` change request, `spike:` spike, `chore:`/`ci:`/`build:` chore, `docs:`/`refactor:`/`test:`/`perf:` task, `(scope)` → component; assigned to the author when they are on the project, placed in the active sprint (optional), labelled `from-git`. Once per commit.
- **Warn** — recorded under *Commits and pull requests without a work item*, where each can be linked to a key or turned into an item.
- **Off**.

*Setup files* gives the GitHub Actions workflow, the Azure Pipeline and the commit-msg hook (it adds the key from a branch named like `feature/FLEET-12-…`). They call `POST /api/public/dev/check` with the repository token (secret `SYNAPSE_TOKEN`, shown once; *New token* replaces it). Merge commits pass; a PR without a key passes when its branch's commits were linked.

### Calls from the mailbox and recordings

With Gmail or Outlook connected, the calendar (a week back to a month ahead) is read with each mailbox sync: meetings with a Zoom / Meet / Teams link or outside guests become calls, filed on the project their title, project code or guests' company points to — else under *Calls → Not filed*. Updates and cancellations follow; calls Synapse scheduled itself are not doubled. *My account → Meeting apps → Call invites from my mailbox* turns it off; *Calls → Check my invites* runs it now.

For a call that already happened, *Add a past call* on the project, then on the call either upload the transcript or **Upload recording** (mp3, m4a, wav, ogg, flac, mp4, webm, mov; up to 95 MB). Recordings up to 25 MB are transcribed with Workers AI (Whisper) and the minutes written; larger ones are kept, and the transcript can be added by hand.
