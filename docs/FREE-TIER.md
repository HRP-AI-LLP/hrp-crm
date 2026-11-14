# Free-tier budget

These limits were checked in October 2026. Providers change them, so re-check the pages under Sources before you rely on them.

| Service | Free allowance | How Synapse stays inside it |
|---|---|---|
| Neon | 100 projects; 10 branches/project; **1 GB storage per project** (20 GB total); **100 CU-hours per project per month**; computes up to 2 CU; scale to zero after 5 min (can't be disabled); 6 h restore window | One project. Branches: `main`, `dev`, one preview per open PR, one pre-deploy snapshot. Scale-to-zero keeps idle cost at zero. Expect a cold start of about 0.5–1 s after idle. |
| Workers | 100k requests/day; **10 ms CPU per request** | Static assets don't count toward requests. Metadata and principal caching means a typical API call does 1–2 short queries. **Risk:** PBKDF2 at login can exceed 10 ms. Login is rare and Cloudflare tolerates occasional overages, but the long-term fix is the Argon2 service or the $5 Workers Paid plan. |
| Hyperdrive | Included on Free; **100k queries/day** | Caching is off by design (see SECURITY.md). If you exceed it, remove the `hyperdrive` binding and the Worker falls back to `DATABASE_URL` (direct TCP to the Neon pooler). |
| Queues | **10,000 operations/day** (about 3 per message: write, read, ack), **24 h** retention | Used for durable jobs only. If the binding is removed, jobs run in `waitUntil`. |
| Workers KV | 100k reads and 1k writes per day | KV holds only metadata bundles, written once per `meta_version`. Hostname resolution and principals use isolate memory plus the Cache API. |
| Workers AI | Daily free allowance measured in neurons | Per-tenant daily cap (`AI_DAILY_LIMIT_PER_TENANT`). Lead scoring always has a rule-based fallback, and Groq and Gemini act as overflow. |
| Vectorize | Free allowance on stored and queried dimensions | 1024-dim bge-m3 vectors, ~900-character chunks, one namespace per tenant. |
| R2 | **10 GB storage**, 1M writes and 10M reads per month, no egress fees | Attachments, signatures and backups. Per-workspace quota (`settings.storageQuotaMb`, default 1 GB); backups keep the newest 7 and are written in small parts so each step fits the CPU limit. |
| Mailbox sync | Neon compute | Background sync every ~15 min only 07:00–21:00 IST (≈35 CU-h/month while any mailbox is connected); on-demand sync otherwise. `MAIL_SYNC_ALWAYS=true` for 24h (≈60 CU-h). |
| Web Push | Free (browser push services) | Sent after writes and by the 5-minute cron; at most 50 notifications per workspace per run. |
| WhatsApp campaigns | Workers CPU / Neon compute | Sent in batches of up to 80 per campaign every 5 minutes (first batch at once). A KV flag keeps the cron from waking the database when no campaign is running. WhatsApp's own pricing applies per conversation. |
| Email digests | Resend free tier (3,000/month, 100/day) | Each recipient is one email. A KV timestamp keeps the database asleep until the next digest is due. |
| Webhook log | Neon storage | Deliveries are kept 30 days. |
| Intelligence sweep | Neon compute | Hourly (KV-gated) set-based SQL for scores and insights; no AI calls. Auto meeting prep is off by default and capped by a daily budget per workspace. New conversations are embedded in batches of 100 per hour when Vectorize is bound. |
| Agents and Ask Synapse | Workers AI / your own keys | Count against the per-tenant daily AI cap like other AI features; every agent has a rule-based result when the cap is reached. Recording transcription uses Workers AI Whisper (`AI_MODEL_WHISPER`). |
| Books | Neon compute and storage | Journals are written in the same transaction as the document; reports are single grouped queries over posted lines (indexed by tenant, account and date). The daily cron runs recurring documents (at most 200 profiles and 12 catch-up runs each per workspace per day). A journal line is roughly 200 bytes, so 1 GB holds millions. |
| Cloudflare for SaaS | **100 custom hostnames** included, then $0.10 each | Self-serve custom domains for up to 100 tenants at no cost. |

## When to start paying

The first thing to upgrade is **Workers Paid ($5/mo)**. It raises the CPU limit, Queues limits and Workers AI headroom. After that, **Neon Launch**, once a tenant's data or compute outgrows 1 GB / 100 CU-h. No code changes are needed for either.

## Sources

- [Neon plans and free-plan limits](https://neon.com/faqs/free-plan-limits-and-quotas)
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Queues on the Workers Free plan (changelog, 2026-02-04)](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)
- [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)
