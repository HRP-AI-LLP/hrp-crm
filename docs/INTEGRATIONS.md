# Integrations

SanchalanOS connects to these outside services:

| Integration | What it does | Who sets it up |
|---|---|---|
| **Gmail / Outlook** | Logs mail with customers on their timeline, sends from the person's own address, and puts CRM meetings in their calendar | **HRP AI once:** register OAuth apps. **Then each user** connects their own mailbox in *My account*. |
| **Razorpay** | Payment links for invoices and order milestones; paid links record the receipt automatically | Each workspace, with its own keys (*Settings → Integrations*) |
| **UPI QR** | Pay-by-QR on printed invoices (no gateway) | Each workspace (*Billing & GST → Settings → UPI ID*) |
| **Facebook & Instagram lead ads** | Lead form submissions become leads within seconds | **HRP AI once:** Meta app and app review. **Then each workspace admin** clicks *Connect with Facebook*. |
| **Google Ads lead forms** | Lead form assets post leads by webhook | Each workspace (*Create webhook*), then paste the URL and key into Google Ads |
| **Exotel** | Click-to-call, call recordings, inbound call logging, missed-call follow-ups | Each workspace, with its own Exotel account |
| **WhatsApp Business (Cloud API)** | Shared inbox, approved templates, campaigns, documents, read receipts, STOP opt-outs | Each workspace, with its own WhatsApp Business number (*Settings → Channels*) |
| **Tally Prime / ERP 9** | Ledgers, invoices, credit notes and receipts into Tally; receipts from Tally back | Each workspace's accountant runs the connector (*Billing & GST → Tally*) |
| **Zapier / Make / n8n / your code** | REST API, OpenAPI file, webhooks | Each workspace (*Developers*, *Settings → API keys*) |
| **Firebase Cloud Messaging** | Notifications in the Android app | **HRP AI once** (see `mobile/README.md`) |

All provider credentials are stored encrypted (AES-GCM, with the workspace id as AAD) and the API never returns them. Every inbound webhook is either signed or reached through an unguessable per-workspace key. Each payment, lead, call and email is processed only once, however often the provider retries it.

---

## 1. Platform setup (HRP AI, once per environment)

**Every key below is set in the app: Settings → Connection keys** (platform admins). Each connection there has a step-by-step guide (with the redirect and webhook addresses to copy), a *Save and test* button that checks the keys with the provider, and generators for VAPID key pairs, webhook secrets and verify tokens. Secret keys are encrypted with `DATA_ENCRYPTION_KEY` and only their last characters are shown afterwards. A key saved there takes the place of the same name in `.env` / Worker secrets (those still work as a fallback; *Remove* brings them back). Changes reach every server instance within 30 seconds.

Platform admins: the people listed in Settings → Connection keys → Platform admins; while nobody is listed, the owners of the first workspace created (on a local server, any workspace owner).

A workspace may use **its own GSP account** for GST (Settings → Connection keys → This workspace only); every other connection's keys are platform-wide. Connections a workspace makes itself (Razorpay, Exotel, WhatsApp, channels, connectors, RazorpayX, Tally, code webhooks) each show their own setup guide where they are connected.

Only these must stay in the server's environment: the database address, `JWT_SECRET` and `DATA_ENCRYPTION_KEY` (needed before anything in the database can be read) and the Cloudflare bindings in `wrangler.jsonc`.

The steps below are the same as the in-app guides.

The callback and webhook host is `https://www.sanchalan.hrpai.in`. For local testing with `pnpm local`, also add `http://localhost:5173` and `http://localhost:8787`.

### Google (Gmail + Calendar)

1. In Google Cloud Console, create a project. Then go to *APIs & Services* and enable the **Gmail API** and the **Google Calendar API**.
2. Under *OAuth consent screen*, choose External and add:
   - your app name, logo, the support email `info@hrpai.in`, and links to the privacy policy and terms on hrpai.in;
   - the scopes `gmail.readonly`, `gmail.send` and `calendar.events`.
3. Under *Credentials*, create an **OAuth client ID** of type *Web application* with these authorised redirect URIs:
   - `https://www.sanchalan.hrpai.in/api/public/oauth/google/callback`
   - `http://localhost:5173/api/public/oauth/google/callback`
4. Store the credentials as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` (see *Secrets* below).

> **Verification:** `gmail.readonly` is a *restricted* scope. While the app is in **Testing** mode only test users you list (up to 100) can connect, which is enough for pilots. Opening it to every customer needs Google's app verification and a yearly third-party security assessment (CASA). Plan a few weeks for this. Calendar alone (`calendar.events`) needs only standard verification.

### Microsoft (Outlook / Microsoft 365)

1. In the Entra admin centre, go to *App registrations → New registration*:
   - *Supported account types:* **any organisational directory and personal Microsoft accounts**
   - *Redirect URIs (Web):* the three URLs as above, ending in `/api/public/oauth/microsoft/callback`
2. Under *Certificates & secrets*, create a client secret (note when it expires).
3. Under *API permissions*, add these Microsoft Graph **delegated** permissions: `offline_access`, `openid`, `email`, `User.Read`, `Mail.ReadWrite`, `Mail.Send` and `Calendars.ReadWrite`.
4. Store them as `MS_CLIENT_ID` (Application ID) and `MS_CLIENT_SECRET`.

> Complete **publisher verification** (it needs a Microsoft Partner ID) so customers see "verified" on the consent screen. Some companies block user consent; their IT admin then grants consent once for the whole organisation.

### Meta (Facebook & Instagram lead ads)

1. At developers.facebook.com, create an app of type *Business* and add **Facebook Login for Business** and **Webhooks**.
2. In the Facebook Login settings, set the *Valid OAuth redirect URIs* to the three callback URLs ending in `/api/public/oauth/meta/callback`.
3. Under *Webhooks*, choose the *Page* object:
   - *Callback URL:* `https://www.sanchalan.hrpai.in/api/public/hooks/meta-leads`. Use one URL for all workspaces; the dev app uses the dev host.
   - *Verify token:* any random string. Store it as `META_VERIFY_TOKEN`.
   - Subscribe to the **leadgen** field.
4. Request these permissions through App Review: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `leads_retrieval` and `business_management`. Meta also requires **Business Verification** of HRP AI LLP.
5. Store `META_APP_ID` and `META_APP_SECRET`. The app secret also verifies every webhook signature.

> Until App Review is approved, only people with a role on the Meta app (admins, developers, testers) can connect pages. That is enough for pilots.

### Meeting apps (Zoom, Google Meet, Microsoft Teams)

Each person connects their own accounts (several per app) under **My account → Meeting apps**. Calls scheduled on a project can then be created on that account, and the transcript is fetched about 5–10 minutes after the call ends (checked on the 5-minute cron for up to 7 days) and analysed into minutes.

- **Google Meet** reuses the Google OAuth client. Enable the **Google Meet REST API** and the **Google Calendar API**, add the scope `https://www.googleapis.com/auth/meetings.space.readonly` to the consent screen, and add redirect URIs ending in `/api/public/oauth/gmeet/callback`. Transcripts need a Workspace edition with Meet transcription, switched on in the meeting.
- **Microsoft Teams** reuses the Microsoft app registration. Add redirect URIs ending in `/api/public/oauth/msmeet/callback` and the delegated Graph permissions `Calendars.ReadWrite`, `OnlineMeetings.ReadWrite` and `OnlineMeetingTranscript.Read.All`. The transcript permission needs **admin consent** in each customer tenant. Work or school accounts only.
- **Zoom**: create a *General app* (user-managed OAuth) in the Zoom App Marketplace with the redirect URIs ending in `/api/public/oauth/zoom/callback` and the scopes `user:read:user`, `meeting:write:meeting`, `meeting:read:meeting`, `cloud_recording:read:list_user_recordings` and `cloud_recording:read:list_recording_files` (classic names: `user:read`, `meeting:write`, `recording:read`). Set the secrets `ZOOM_CLIENT_ID` and `ZOOM_CLIENT_SECRET`. Transcripts come from cloud recording with *Audio transcript* on (Pro plan or above); meetings created from SanchalanOS turn cloud recording on.

### GitHub and Azure DevOps (code links for work items)

An admin with the *developers* permission adds a connection in any project's **Work setup → Code connections**. SanchalanOS shows a payload URL and a secret once.

- **GitHub**: repository or organisation → Settings → Webhooks → Add webhook; payload URL as shown, content type `application/json`, the secret; events *Pushes*, *Branch or tag creation*, *Pull requests*, *Workflow runs*. Requests are checked with `X-Hub-Signature-256`.
- **Azure DevOps**: Project settings → Service hooks → *Web Hooks*, one subscription per event (*Code pushed*, *Pull request created*, *Pull request updated*, *Pull request merged*, *Build completed*), URL as shown, basic authentication user `synapse` with the secret as the password.

Any work item key (`FLEET-12`) in a branch name, commit message, PR title or description links that branch / commit / PR / build to the item. Each project chooses in *Automation from code* which state an item moves to when its branch is created, its PR opens or merges, or its build fails.

### GitHub App (repository picker, checks on pull requests, branches)

One app serves the whole platform. Create it at GitHub → Settings → Developer settings → GitHub Apps → New:

- **Callback / Setup URL**: `https://<app host>/api/public/github/setup` (tick *Redirect on update*); **Webhook URL**: `https://<app host>/api/public/github/app` with a webhook secret.
- **Repository permissions**: Checks *read & write*, Contents *read-only*, Metadata *read-only*, Pull requests *read-only*; Administration *read & write* only if SanchalanOS should set branch protection (*Require check*). To create branches from work items Contents needs *read & write*.
- **Subscribe to events**: Push, Pull request, Create, Workflow run (installation events come by default).
- Generate a private key (PEM).

Set `GITHUB_APP_ID`, `GITHUB_APP_SLUG` (the app's URL name), `GITHUB_APP_PRIVATE_KEY` (the PEM; in `.env` on one line with `\n` for line breaks — `pnpm local` converts them) and `GITHUB_APP_WEBHOOK_SECRET` (`wrangler secret put …` in the cloud). A workspace admin then clicks **Install the GitHub App** (Work setup → GitHub App) and picks the organisation and repositories; GitHub returns to SanchalanOS, which ties that installation to the workspace. Uninstalling in GitHub removes it here.

Repositories linked through the app get the **SanchalanOS work items** check run on every push and PR; webhooks from the app also link branches, commits, PRs and builds exactly as the per-workspace webhook connections below do (use one or the other per repository).

### Secrets (fallback)

Preferably set these in Settings → Connection keys. The environment route below still works; a value saved in the app wins. These values are required to turn the features on: without Google or Microsoft keys the mailbox buttons stay hidden, and without Meta keys the Facebook card says "not set up".

Either export the variables and rerun `pnpm setup`, which uploads them as Worker secrets, or set them directly:

```powershell
cd apps/api
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev   # repeat for each name and for --env production
```

Names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`, `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET`.

For `pnpm local`, set the same variables in the terminal before running it.

### Cloudflare WAF

Providers call these paths without a browser, so the custom domains' managed challenge must skip them. Extend the existing skip rule for `/api/public/*` (which covers all of these):

- `/api/public/hooks/*` for Razorpay, Meta, Google Ads and Exotel
- `/api/public/oauth/*` for the OAuth callbacks (these are browser redirects, but skipping avoids an extra challenge)

---

## 2. Workspace setup (customers)

### Razorpay

1. In the Razorpay Dashboard, go to *Accounts & Settings → API Keys* and generate a key pair. Use test mode (`rzp_test_…`) to try it first.
2. In *Settings → Integrations → Connect Razorpay*, enter the key ID, the key secret and a webhook secret of your choice. SanchalanOS checks the keys with Razorpay before saving them.
3. In Razorpay, go to *Webhooks → Add* and paste the webhook URL shown on the card. Use the same secret and tick the events `payment_link.paid`, `payment_link.partially_paid`, `payment_link.cancelled` and `payment_link.expired`.
4. On any issued invoice (or order or milestone), use **Collect online** to send the link. Razorpay can also send it by SMS or email, or you can share it on WhatsApp.
   - Only one link per invoice or milestone can be open at a time.
   - Creating a link needs edit rights on the document, or the Billing admin permission.

The **UPI QR** needs no gateway. Set the UPI ID and payee name in *Billing & GST → Settings*, and every issued, unpaid invoice prints a QR for its balance. Payments made this way are reconciled from the bank statement, so record them with *Record payment*.

### Exotel

1. In Exotel, go to *Settings → API* and copy the SID, API key and token. Note which **ExoPhone** customers should see.
2. In *Settings → Integrations → Connect Exotel*, choose the region: Singapore (`api.exotel.com`) or Mumbai (`api.in.exotel.com`).
3. **Incoming calls:** in your Exotel call flow (App Bazaar), add a **Passthru** applet with the *Incoming calls* URL shown on the card, after the Connect applet.
   - Every call is logged on the caller's contact, lead or account.
   - Unknown callers become leads (this can be turned off).
   - A missed call creates a high-priority *Call back* task for the record owner.
4. **Click-to-call:** each salesperson enters their own mobile number in *My account*. The **Call** button on a lead, contact, account or ticket rings their phone first, then connects the customer. Outcome, duration and recording are logged when the call ends.
5. **Fraud guards:**
   - Only the record's own number can be dialled.
   - Only Indian numbers are allowed unless an admin enables international calls.
   - Each person can place up to 60 calls an hour (configurable).

### Facebook & Instagram lead ads

1. In *Settings → Integrations → Connect with Facebook*, sign in and grant the pages. You need *Manage* or *Advertise* access on each page.
2. Each page is subscribed to lead notifications. A page can feed one workspace only; to move it, disconnect it from the old workspace first.
3. Optionally, choose who receives new leads. Otherwise your assignment rules decide, and the workspace owner is the fallback.
4. **Lead details:**
   - Each lead gets a source (`facebook` or `instagram`) and source detail (form and campaign name), plus a follow-up 30 minutes later.
   - All form answers are saved as a note.
   - When the email or phone already belongs to an open lead or a contact, the enquiry is added to that record instead of creating a duplicate.

### Google Ads lead forms

1. In *Settings → Integrations → Create webhook*, copy the **Webhook URL** and **Key**.
2. In Google Ads, open the *lead form asset → Lead delivery → Webhook integration*, paste both, and click *Send test data*. The test lead appears marked `[test]`.

### Gmail / Outlook (each person)

In *My account → Email, calendar & calls*, click **Connect Gmail** or **Connect Outlook**.

- **What is logged:** only mail exchanged with people who are **contacts or open leads that this person can see** in SanchalanOS. Mail between colleagues and mail with anyone else is never stored. Each person can add addresses or domains that are never logged.
- **When it syncs:** about every 15 minutes during business hours (07:00–21:00 IST), whenever someone opens a customer's page, or immediately with *Sync now*. The first sync looks back 3 days.
- **Sending:** mail written in SanchalanOS goes out from the person's own mailbox and appears in their Sent folder. Replies stay in the same thread.
- **Calendar:** their own SanchalanOS meetings and site visits are mirrored to their calendar. This can be switched off.
- **Disconnecting:** disconnecting, or an admin disabling the user, revokes access. If Google or Microsoft revoke access, the card shows *Reconnect*.

---

### WhatsApp Business

1. In Meta Business Suite → WhatsApp Manager, add the business number. Note the **Phone number ID** and the **WhatsApp Business Account ID**. Create a **system user** token with `whatsapp_business_messaging` and `whatsapp_business_management`.
2. In *Settings → Channels → Connect channel*, choose WhatsApp and enter the phone number ID, the business account ID, the token, the app secret and a verify token of your choice.
3. In the Meta app's WhatsApp → Configuration, set the callback URL to the channel's *Inbound URL* with the same verify token, and subscribe to **messages**. Message status updates (delivered, read, failed) arrive on the same subscription.
4. *Templates → Sync from WhatsApp* brings in approved templates; *New template* submits one for approval. Marketing templates always carry a **Stop promotions** button, and tapping it (or replying STOP) opts the number out.
5. **Rules SanchalanOS enforces:**
   - free text only within 24 hours of the customer's last message, templates otherwise;
   - marketing templates and campaigns only to people with recorded consent who have not opted out;
   - quotes go as their public link; invoices and orders as a signed link valid for 30 days, with *Pay online* when a Razorpay link is open.
6. **Campaigns** (*Campaigns*, needs the campaigns permission): pick a template, map its variables to fields, choose the audience with filters, *Check who will receive it*, then send or schedule. Up to 5,000 people per campaign, sent in batches every few minutes. Results show delivered, read, replied, why people were skipped, and deals won within 30 days.

### Tally

1. On the PC that runs Tally, install Node.js 18 or newer. In Tally: F1 Help → Settings → Connectivity → TallyPrime acts as **Server** (or Both) on port **9000**, and keep the company open.
2. In *Billing & GST → Tally*, click **Connect Tally**. Copy the token (shown once) and download the connector.
3. Run it: `node synapse-tally.mjs --url <connector URL> --token <token>`. Add `--once` for a single run or `--dry-run` to see what it would do. To run it at log-on, create a Windows Task Scheduler task with the same command.
4. **What happens:**
   - customer ledgers go first (under *Sundry Debtors*, with GSTIN, state and address), then sales invoices and credit notes with bill references, then receipts allocated to invoices;
   - ledger names for sales, GST, round-off and bank come from *Billing & GST → Settings*; create those ledgers in Tally first;
   - anything Tally rejects shows under *Tally* with Tally's message; fix it in Tally and click *Retry failed*;
   - an invoice cancelled in SanchalanOS after it reached Tally is flagged *Check in Tally*, so the accountant cancels it there;
   - receipts entered in Tally are recorded here and settle the invoices named in their bill references; parties that match no customer are listed.
5. Only documents dated on or after *Sync documents dated from* (default: the start of the financial year) are synced.

> The connector has been tested against sample Tally XML, not yet against a live Tally Prime install. Try it on a copy of the company first.

### Developers (Zapier, Make, n8n, your code)

- **Developers** in the menu shows the base URL, examples, the workspace's OpenAPI file (with its own custom fields) and the event list.
- **Webhooks** can be added there, or by integrations through `POST /api/v1/hooks` (REST hooks). Every delivery is logged for 30 days, failed ones can be sent again, and a test ping is one click.
- Verify `X-Synapse-Signature-V2: t=<unix>,v1=<hex>`, where `v1 = HMAC-SHA256(secret, "<t>.<raw body>")`, and reject deliveries older than five minutes.
- Each API key has a per-minute limit (60–3,000; default 600).

## 3. Free-tier note

While any mailbox is connected, background sync wakes the database every 15 minutes. Neon then stays awake for 5 more minutes before it sleeps again, so the compute is up roughly a third of the time sync runs.

To keep this inside Neon's free 100 CU-hours a month, background sync only runs **07:00–21:00 IST**, about 35 CU-hours a month at 0.25 CU. Opening a customer's page and *Sync now* still sync at any hour.

To sync around the clock, set the Worker variable `MAIL_SYNC_ALWAYS=true`. That is about 60 CU-hours a month, so plan to move to Neon Launch as usage grows.
