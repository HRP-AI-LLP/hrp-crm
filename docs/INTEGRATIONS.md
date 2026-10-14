# Integrations

Synapse connects to five outside services:

| Integration | What it does | Who sets it up |
|---|---|---|
| **Gmail / Outlook** | Logs mail with customers on their timeline, sends from the person's own address, and puts CRM meetings in their calendar | **HRP AI once:** register OAuth apps. **Then each user** connects their own mailbox in *My account*. |
| **Razorpay** | Payment links for invoices and order milestones; paid links record the receipt automatically | Each workspace, with its own keys (*Settings → Integrations*) |
| **UPI QR** | Pay-by-QR on printed invoices (no gateway) | Each workspace (*Billing & GST → Settings → UPI ID*) |
| **Facebook & Instagram lead ads** | Lead form submissions become leads within seconds | **HRP AI once:** Meta app and app review. **Then each workspace admin** clicks *Connect with Facebook*. |
| **Google Ads lead forms** | Lead form assets post leads by webhook | Each workspace (*Create webhook*), then paste the URL and key into Google Ads |
| **Exotel** | Click-to-call, call recordings, inbound call logging, missed-call follow-ups | Each workspace, with its own Exotel account |

All provider credentials are stored encrypted (AES-GCM, with the workspace id as AAD) and the API never returns them. Every inbound webhook is either signed or reached through an unguessable per-workspace key. Each payment, lead, call and email is processed only once, however often the provider retries it.

---

## 1. Platform setup (HRP AI, once per environment)

The callback and webhook hosts are `https://hrpsynapse.hrpai.in` for prod and `https://hrpsynapse-dev.hrpai.in` for dev. For local testing with `pnpm local`, also add `http://localhost:5173` and `http://localhost:8787`.

### Google (Gmail + Calendar)

1. In Google Cloud Console, create a project. Then go to *APIs & Services* and enable the **Gmail API** and the **Google Calendar API**.
2. Under *OAuth consent screen*, choose External and add:
   - your app name, logo, the support email `info@hrpai.in`, and links to the privacy policy and terms on hrpai.in;
   - the scopes `gmail.readonly`, `gmail.send` and `calendar.events`.
3. Under *Credentials*, create an **OAuth client ID** of type *Web application* with these authorised redirect URIs:
   - `https://hrpsynapse.hrpai.in/api/public/oauth/google/callback`
   - `https://hrpsynapse-dev.hrpai.in/api/public/oauth/google/callback`
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
   - *Callback URL:* `https://hrpsynapse.hrpai.in/api/public/hooks/meta-leads`. Use one URL for all workspaces; the dev app uses the dev host.
   - *Verify token:* any random string. Store it as `META_VERIFY_TOKEN`.
   - Subscribe to the **leadgen** field.
4. Request these permissions through App Review: `pages_show_list`, `pages_read_engagement`, `pages_manage_metadata`, `pages_manage_ads`, `leads_retrieval` and `business_management`. Meta also requires **Business Verification** of HRP AI LLP.
5. Store `META_APP_ID` and `META_APP_SECRET`. The app secret also verifies every webhook signature.

> Until App Review is approved, only people with a role on the Meta app (admins, developers, testers) can connect pages. That is enough for pilots.

### Secrets

These values are required to turn the features on: without Google or Microsoft keys the mailbox buttons stay hidden, and without Meta keys the Facebook card says "not set up".

Either export the variables and rerun `pnpm setup`, which uploads them as Worker secrets, or set them directly:

```powershell
cd apps/api
npx wrangler secret put GOOGLE_CLIENT_SECRET --env dev   # repeat for each name and for --env production
```

Names: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `MS_CLIENT_ID`, `MS_CLIENT_SECRET`, `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`.

For `pnpm local`, set the same variables in the terminal before running it.

### Cloudflare WAF

Providers call these paths without a browser, so the custom domains' managed challenge must skip them. Extend the existing skip rule for `/api/public/*` (which covers all of these):

- `/api/public/hooks/*` for Razorpay, Meta, Google Ads and Exotel
- `/api/public/oauth/*` for the OAuth callbacks (these are browser redirects, but skipping avoids an extra challenge)

---

## 2. Workspace setup (customers)

### Razorpay

1. In the Razorpay Dashboard, go to *Accounts & Settings → API Keys* and generate a key pair. Use test mode (`rzp_test_…`) to try it first.
2. In *Settings → Integrations → Connect Razorpay*, enter the key ID, the key secret and a webhook secret of your choice. Synapse checks the keys with Razorpay before saving them.
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

- **What is logged:** only mail exchanged with people who are **contacts or open leads that this person can see** in Synapse. Mail between colleagues and mail with anyone else is never stored. Each person can add addresses or domains that are never logged.
- **When it syncs:** about every 15 minutes during business hours (07:00–21:00 IST), whenever someone opens a customer's page, or immediately with *Sync now*. The first sync looks back 3 days.
- **Sending:** mail written in Synapse goes out from the person's own mailbox and appears in their Sent folder. Replies stay in the same thread.
- **Calendar:** their own Synapse meetings and site visits are mirrored to their calendar. This can be switched off.
- **Disconnecting:** disconnecting, or an admin disabling the user, revokes access. If Google or Microsoft revoke access, the card shows *Reconnect*.

---

## 3. Free-tier note

While any mailbox is connected, background sync wakes the database every 15 minutes. Neon then stays awake for 5 more minutes before it sleeps again, so the compute is up roughly a third of the time sync runs.

To keep this inside Neon's free 100 CU-hours a month, background sync only runs **07:00–21:00 IST**, about 35 CU-hours a month at 0.25 CU. Opening a customer's page and *Sync now* still sync at any hour.

To sync around the clock, set the Worker variable `MAIL_SYNC_ALWAYS=true`. That is about 60 CU-hours a month, so plan to move to Neon Launch as usage grows.
