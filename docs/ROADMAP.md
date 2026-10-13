# Roadmap

## Built in this bootstrap

- Multi-tenant core: pooled Postgres with FORCE RLS, tenant registry, hostname and custom-domain resolution, Cloudflare for SaaS hostname API, self-serve signup
- Auth: password login, lockout, rotating refresh tokens with reuse detection, change and reset password, invite users
- Authorization: RBAC (own/team/all scopes), ABAC conditions on user attributes, field-level security, admin areas
- Metadata engine: custom objects and fields (15 types), the JSONB + EAV index hybrid, pipelines and stages, public web forms, metadata versioning for caches
- CRM: leads, contacts, accounts, deals, custom-object records, lead conversion, pipeline board, tasks, timeline, global search, dashboard
- Automation: workflows (create task, update field, assign round-robin, webhook, email, WhatsApp, AI score), outbound webhook subscriptions with HMAC signatures
- Channels: WhatsApp Cloud API (signed inbound and outbound), Resend email, generic webhook. Inbound messages are matched to a contact or lead (a new lead is created if needed) and get a sentiment score.
- Workspace-owned AI keys: OpenAI/Azure, Anthropic, Gemini, Groq, OpenRouter, OpenAI-compatible; priority order, PII switch, connection test, optional platform fallback
- Hostnames: shared app hosts hrpsynapse.hrpai.in / hrpsynapse-dev.hrpai.in, optional per-workspace hosts, customer custom domains
- AI: lead scoring (rules blended with an LLM), sentiment, record summary, next-best-actions, email drafts with knowledge-base grounding, knowledge-base RAG, a PII-aware provider fallback chain, per-tenant quotas and usage metering
- Industry modules: Real Estate, Healthcare, E-Commerce, Financial Services
- Ops: idempotent provisioning, dev/prod CI/CD, Neon preview branches per PR, pre-deploy prod snapshot, audit log UI

## Scaled in the second round (four phases)

- **Brand**: the app follows www.hrpai.in — navy/cyan palette, Inter, logo emblem, mesh-and-grid sign-in art.
- **Data & views**: saved personal and shared list views, a filter builder, a column chooser, total counts, bulk edit/delete/export, CSV import with column mapping, Indian formats and upsert, FLS-aware CSV export, duplicate detection, merge with per-field choices, and related lists.
- **Visual builders**: formula fields (safe expression language shared by API and UI), roll-up summaries, validation rules, dependent picklists, conditional visibility and requirement, a drag-and-drop page layout builder, and a visual automation builder with nested if/else branches, formula conditions and run history.
- **Sales productivity**: products and price books, GST-ready quotes (HSN/SAC, CGST+SGST/IGST, amount in words) with a print/PDF view and customer accept/decline links, email templates and sending, a calendar with reminders, in-app notifications, a forecast with quotas and drill-down, and a report and dashboard builder (bar, line, donut, funnel, number, pivot).
- **Security & admin**: TOTP two-factor with recovery codes and a workspace-wide requirement, email or link invitations and password resets, session management, teams, team-lead visibility, sharing rules, per-record sharing, scoped API keys, and a usage page.

## Next (suggested order)

1. **Argon2id hashing service on Oracle ARM.** This removes the PBKDF2 CPU risk.
2. **Email sync (IMAP/Gmail)** on the Oracle worker, so replies land on the timeline automatically.
3. **Scheduled report digests** by email, and dashboard sharing by link.
4. **Approval processes** (discount approvals on quotes) built on the automation engine.
5. **Mobile PWA**: offline-first record views and a click-to-call/WhatsApp dialer.
6. **Platform admin console** for HRP staff, using a separate audited role (no RLS bypass inside the app).
7. **Hash-chained audit export** for compliance customers.
8. **Per-region data residency** (one Neon project per region, routed through the `tenants` registry).
