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

## Third round: the full furniture / interiors business suite (six phases)

Built to cover everything in the ELVM Homes proposal on top of the CRM.

- **Phase 5 — files, leads, quotes:** R2 attachments with signed links and quotas; lead sources (walk-in, WhatsApp, Instagram, referral, architect, dealer, campaign), assignment and scoring rules, follow-up reminders, lead aging and source conversion; quote revisions, discount approval rules and a generic approvals inbox.
- **Phase 6 — orders, inventory, purchasing:** apps that switch on per workspace; sales orders with milestones and stock reservation; SKUs, categories, variants, warehouses, an append-only stock ledger, transfers and reorder alerts; vendors, purchase orders and goods receipts.
- **Phase 7 — delivery, installation, service:** shipments and installation jobs with crews, checklists and customer sign-off (signature); service tickets with SLA policies, breach alerts, CSAT and a customer status page.
- **Phase 8 — GST billing:** FY-wise invoice and credit-note series, CGST/SGST vs IGST by place of supply, immutable issued documents, receipts with allocation, receivables aging, overdue reminders, e-invoice JSON, GSTR-1 CSV and Tally XML.
- **Phase 9 — phones:** installable app, My day (GPS check-in, walk-in leads, tasks, follow-ups, jobs), Web Push, offline outbox, code-split bundle, Android TWA and Capacitor shells.
- **Phase 10 — admin:** role dashboards, IP/country restrictions, owner-only R2 backups (nightly option), CSV import templates and opening stock import; an independent security review with all findings fixed.

## Integrations Indian SMB buyers ask for first (Oct 2026)

- **Gmail / Outlook:** per-person OAuth. Mail with visible contacts and leads is logged once per Message-ID. People send from their own address with threading, CRM meetings are mirrored to their calendar, and background sync runs during business hours.
- **Razorpay:** payment links for invoices, orders and milestones, recorded automatically through a signed webhook. Printed invoices carry a UPI pay-by-QR.
- **Lead ads:** Facebook and Instagram leads arrive through Facebook Login and the signed leadgen webhook; Google Ads lead forms arrive through a keyed webhook. Repeat enquiries attach to the existing record.
- **Exotel:** click-to-call that rings the agent first, recordings, inbound call logging, leads for unknown callers and missed-call tasks, with toll-fraud guards.

## Fifth round: competing on fit, not feature count (Oct 2026)

- **Privacy & DPDP Act:** consent ledger with evidence, do-not-contact list, versioned notices, a public request portal with email verification, access exports, erasure (tax records kept), retention rules, breach register with the 72-hour clock, hash-chained audit export.
- **WhatsApp Business:** template sync and submission (marketing templates get a Stop button), shared inbox with assignment, the 24-hour window and read receipts, STOP opt-outs, quotes / invoices / orders sent as links, consent-checked WhatsApp and email campaigns with a delivery funnel and business won in 30 days.
- **Industry solutions:** interior fit-out, modular kitchens, rooftop solar, fabrication, signage: fields, pipelines, apps, payment plans, checklists and KPI targets in one click.
- **Business health:** 24 KPIs with targets, previous period and six-month trend; measured value delivered; revenue projection on the forecast.
- **Reporting:** scheduled email digests that run as each recipient; expiring dashboard share links.
- **Tally:** two-way sync through a zero-dependency Node connector on the accountant's PC.
- **Developer platform:** per-workspace OpenAPI 3.1, REST hooks, webhook delivery log and redelivery, timestamped signatures, per-key rate limits.
- **Android notifications** through Firebase Cloud Messaging.

## Sixth round: revenue intelligence (Nov 2026)

An AI layer of the kind platforms such as Zambyl add on top of a CRM, built into Synapse and fitted to made-to-order businesses (see [INTELLIGENCE.md](INTELLIGENCE.md)):

- **Context layer:** every lead, contact, account and deal is gathered with its customer, deals, quotes, orders, invoices, tickets, competitors, conversations, meetings and scores, as the viewer sees them. Facts are numbered and cited. Stray emails are linked by address or company domain.
- **Eleven agents** across pipeline creation, deal execution, customer success and growth, and team performance. Each produces a rule-based result first and uses AI on top. Field changes need approval.
- **Copilot workspace**, a record Copilot tab, meeting brief and debrief (with recording transcription), an hourly insights feed with notifications, deal-risk and account-health scores, competitors with battlecards, and Ask Synapse.

## Next (suggested order)

1. **Pilots with 2–3 made-to-order businesses** on dev: what they ask for decides the next round. Measure agent usefulness: which briefs and debriefs get used, and how many suggestions are applied versus rejected.
2. **Platform app reviews:** Google OAuth verification with the CASA assessment for Gmail, Meta App Review with business verification (also needed for WhatsApp templates at scale), and Microsoft publisher verification.
3. **Test the Tally connector against a live Tally Prime** and adjust tags if a Tally release differs; add stock-item sync for inventory-tracked invoices.
4. **More telephony and payment providers:** Knowlarity, MyOperator and Ozonetel behind the same interface; Cashfree and PhonePe as alternatives to Razorpay.
5. **Argon2id hashing service on Oracle ARM.** This removes the PBKDF2 CPU risk.
6. **IMAP mailboxes** (Zoho Mail, GoDaddy, cPanel hosts) on the Oracle worker.
7. **E-invoice IRP / e-way bill API** through a GSP once a customer needs direct filing.
8. **iOS store build** with APNs through Firebase, and background location for field teams.
9. **Restore from backup** (today: download and inspect; restore is done by HRP staff).
10. **Platform admin console** for HRP staff, using a separate audited role.
11. **Per-region data residency** (one Neon project per region, routed through the `tenants` registry).
12. **Certifications** (ISO 27001 / SOC 2) once paying customers ask; the audit chain, DPDP tooling and access controls are the groundwork.
