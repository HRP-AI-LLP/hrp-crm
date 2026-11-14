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
