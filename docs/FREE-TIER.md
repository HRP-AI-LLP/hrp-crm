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
| Cloudflare for SaaS | **100 custom hostnames** included, then $0.10 each | Self-serve custom domains for up to 100 tenants at no cost. |

## When to start paying

The first thing to upgrade is **Workers Paid ($5/mo)**. It raises the CPU limit, Queues limits and Workers AI headroom. After that, **Neon Launch**, once a tenant's data or compute outgrows 1 GB / 100 CU-h. No code changes are needed for either.

## Sources

- [Neon plans and free-plan limits](https://neon.com/faqs/free-plan-limits-and-quotas)
- [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/)
- [Queues on the Workers Free plan (changelog, 2026-02-04)](https://developers.cloudflare.com/changelog/2026-02-04-queues-free-plan/)
- [Cloudflare for SaaS plans](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/)
