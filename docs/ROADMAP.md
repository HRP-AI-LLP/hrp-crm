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

## Next (suggested order)

1. **MFA (TOTP) and email-based invites and password reset.** Today an admin shares a temporary password once.
2. **Argon2id hashing service on Oracle ARM.** This removes the PBKDF2 CPU risk.
3. **CSV import and export** for all objects, run as a background job with FLS applied to exports.
4. **Saved list views and a filter builder in the UI.** The API already supports filters and sorting on every field.
5. **Email sync (IMAP/Gmail)** on the Oracle worker.
6. **Layout and form builder UI.** The `forms.layout` data model exists; there's no drag-and-drop editor yet.
7. **Reports**: grouped aggregates over the EAV index, scheduled email digests.
8. **Platform admin console** for HRP staff, using a separate audited role (no RLS bypass inside the app).
9. **Hash-chained audit export** for compliance customers.
10. **Per-region data residency** (one Neon project per region, routed through the `tenants` registry).
