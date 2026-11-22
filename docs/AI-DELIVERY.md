# AI delivery — agents across the software lifecycle

A goal ("Fleet tracking for our transport clients") is planned into steps, each done by a specialist
agent; people review what matters; the results land in the project.

```
goal ──► plan (AI or ready-made) ──► person checks / edits the plan ──► Start
          │
          ▼  one step at a time (queue job sdlc.advance, as the person who started it)
   document  ─ BRD, PRD, SRS, FRS, use cases, HLD, LLD, solution architecture, API spec, DB design,
               UX spec, threat model (STRIDE, OWASP, DPDP Act), test strategy / plan, deployment plan,
               runbook, user manual, release notes, ADR, project plan, risk register, SOW, feasibility, RCA
               — with its own diagrams ([[diagram: type | title | brief]] → drawn, embedded as Mermaid)
   diagram   ─ any kind below, on its own
   backlog   ─ epics → stories (acceptance criteria, points) → sub-tasks, created on approval
   test_cases─ cases with steps, linked to the stories they cover, created on approval
   code      ─ the stories go to the coding agent (Claude Code / Codex over MCP, docs/CODING-AGENT.md)
          │
          ▼
   review: Approve · Request changes (the agent redoes it with the note, and the documents after it) · Skip
```

Agents: business analyst, product owner, solution architect, UX designer, security engineer, QA,
DevOps, technical writer, project manager, developer. Each step sees the goal, the project and what
earlier steps produced (most recent first, within a budget).

Review modes: *key steps* (BRD, PRD, SRS, HLD, architecture, SOW, threat model), *every step*, or
*only before changing the project*. Backlog, test cases and code always wait for a person.

## Diagrams

`packages/shared/src/diagrams` (import `@synapse/shared/diagrams`): the AI writes a small JSON spec
(checked with zod; a broken reply is sent back once with the error), from which come

* **Mermaid** (v11) — drawn in the browser to SVG, PNG, JPG; works in GitHub / GitLab / Notion;
* **draw.io** XML — laid out with dagre; real shapes: cylinders for databases, actors, swimlanes,
  C4 boxes, ER tables with crow's-foot ends, UML classes, sequence lifelines with alt / loop frames,
  journey lanes coloured by score.

Kinds with editable shapes: flowchart, architecture, data flow, block, network, deployment, C4
context / container, use case, mind map, org chart, swimlane, state, class, ER, sequence, user
journey. Mermaid-only (the draw.io file holds the picture): gantt, timeline, pie, quadrant, git
graph, sankey, requirement, kanban, any Mermaid.

"Open in draw.io" packs the file into the link (`#R` + base64(deflateRaw(encodeURIComponent(xml))))
— nothing is uploaded.

## Exports

Documents: Word (.docx built in the browser, figures as PNG), PDF (print), HTML (figures as inline
SVG), Markdown. Diagrams: PNG, JPG, SVG, .mmd, .drawio. Every edit is a new version.

## API

`/api/v1/sdlc/catalogue · runs · runs/:id[/plan|/start|/cancel] · steps/:id/review ·
artifacts[/:id[/versions/:v|/drawio]] · diagrams/generate · diagrams/render · documents/generate`

MCP tools for coding agents: `project_documents`, `read_document`, `diagram_format`,
`render_diagram`, `save_diagram`, `save_document`. A Claude Code skill that uses them:
`scripts/agent/skills/sanchalan-docs-diagrams` (copy to `~/.claude/skills/`).

Tables: `sdlc_runs`, `sdlc_steps`, `sdlc_artifacts`, `sdlc_artifact_versions` (migration 0074).
