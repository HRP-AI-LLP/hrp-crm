---
name: sanchalan-docs-diagrams
description: Read a SanchalanOS project's requirements and design documents before implementing, and create documents and diagrams (architecture, data flow, ER, sequence, user journey, block, deployment, C4, class, state, flowchart, gantt and more) in Mermaid and draw.io formats. Use when working on a SanchalanOS project item, or when asked for a design document or diagram.
---

# SanchalanOS documents and diagrams

Needs the `sanchalan` MCP server (see docs/CODING-AGENT.md).

## Before implementing an item
1. `project_documents` with the project key → list of documents and diagrams, approved first.
2. `read_document` the ones that matter for the item (SRS / BRD for rules, HLD / LLD / API spec / DB design for structure, test plan for what will be checked). Follow them; if the code must differ, say so in `request_review`.

## Drawing a diagram
1. `diagram_format` with the kind (er, sequence, architecture, data_flow, deployment, c4_container, class, state, flowchart, user_journey, swimlane, use_case, mindmap, network, block, org_chart; or gantt, timeline, pie, quadrant, gitgraph, sankey, kanban, mermaid for Mermaid-only kinds).
2. Write the spec from the real code: real table, service and endpoint names.
3. `render_diagram` → `mermaid` and `drawio`. In the repository write `docs/diagrams/<name>.mmd` and `docs/diagrams/<name>.drawio`, and embed the Mermaid in markdown docs as a ```mermaid block.
4. `save_diagram` (project, title, spec) so the team sees it under AI delivery with PNG / JPG / SVG / draw.io downloads.

## Writing a document
Markdown, `# Title` first, tables for structured lists, ```mermaid blocks for figures. `save_document` with project, title, markdown and type (hld, lld, api_spec, db_design, adr, runbook, release_notes, user_manual, custom).

## Rules
- Indian businesses: INR, GST, DPDP Act 2023 where personal data is involved.
- Never put secrets, keys or customer personal data in documents or diagrams.
