/**
 * Every outside service SanchalanOS talks to, with the keys it needs and a step-by-step guide to get them.
 *
 * - KEY_GROUPS: keys set in Settings → Connection keys (platform-wide; some a workspace may set for
 *   itself). They used to live in the server's .env; .env still works as a fallback.
 * - GUIDES: how to create the account / app / key for every connection, platform or workspace —
 *   shown next to each connection in the app. "{origin}" in a guide's copy URLs is the app address.
 */

export interface KeyField {
  key: string;
  label: string;
  secret?: boolean;
  /** text (default), a multi-line value (PEM, JSON), on/off, or one of a list */
  kind?: 'text' | 'textarea' | 'bool' | 'select';
  options?: [string, string][];
  placeholder?: string;
  help?: string;
  /** a heading shown above this field (groups with several sections) */
  section?: string;
  /** a "Generate" button makes a random value (webhook secrets, verify tokens) */
  generate?: 'random';
  /** checked when saved */
  pattern?: string;
}

export interface KeyGroup {
  id: string;
  title: string;
  /** what turns on when these keys are set */
  unlocks: string;
  /** platform: one value for every workspace; both: the platform's, unless a workspace sets its own */
  scope: 'platform' | 'both';
  fields: KeyField[];
  /** the keys that must all be set for the group to count as ready (default: every non-bool field without section "Optional") */
  required?: string[];
  /** a server-side check exists (Test button) */
  testable?: boolean;
  /** settings with sensible defaults rather than keys: shown as "Using defaults" / "Changed" */
  options?: boolean;
  /** a key pair can be generated here (VAPID) */
  generatePair?: 'vapid';
  guide: string;
}

export interface Guide {
  title: string;
  /** where to sign up / the console */
  links: { label: string; url: string }[];
  steps: string[];
  /** addresses to paste into the provider ("{origin}" = this app) */
  copy?: { label: string; path: string }[];
  notes?: string[];
}

const BOOL = 'bool' as const;

export const KEY_GROUPS: KeyGroup[] = [
  {
    id: 'google',
    title: 'Google — Gmail, Calendar and Meet',
    unlocks: 'Connect Gmail and Google Calendar mailboxes, Google Meet calls and their transcripts, call invites from Google Calendar.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'GOOGLE_CLIENT_ID', label: 'OAuth client ID', placeholder: '1234567890-abc….apps.googleusercontent.com', pattern: '^[0-9]+-[a-z0-9]+\\.apps\\.googleusercontent\\.com$' },
      { key: 'GOOGLE_CLIENT_SECRET', label: 'OAuth client secret', secret: true, placeholder: 'GOCSPX-…' },
    ],
    guide: 'google',
  },
  {
    id: 'microsoft',
    title: 'Microsoft — Outlook, Calendar and Teams meetings',
    unlocks: 'Connect Outlook / Microsoft 365 mailboxes and calendars, Teams meetings and their transcripts, call invites from Outlook.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'MS_CLIENT_ID', label: 'Application (client) ID', placeholder: '00000000-0000-0000-0000-000000000000', pattern: '^[0-9a-fA-F-]{36}$' },
      { key: 'MS_CLIENT_SECRET', label: 'Client secret value', secret: true, help: 'The secret’s Value, not its Secret ID.' },
    ],
    guide: 'microsoft',
  },
  {
    id: 'zoom',
    title: 'Zoom meetings',
    unlocks: 'Create Zoom meetings for project calls and fetch their cloud-recording transcripts.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'ZOOM_CLIENT_ID', label: 'Client ID' },
      { key: 'ZOOM_CLIENT_SECRET', label: 'Client secret', secret: true },
    ],
    guide: 'zoom',
  },
  {
    id: 'github_app',
    title: 'GitHub App',
    unlocks: 'Repository picker, the “SanchalanOS work items” check on pull requests, required checks and branches created from work items.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'GITHUB_APP_ID', label: 'App ID', placeholder: '1234567', pattern: '^[0-9]{1,12}$' },
      { key: 'GITHUB_APP_SLUG', label: 'App name in its URL (slug)', placeholder: 'hrp-synapse', pattern: '^[a-z0-9-]{1,80}$', help: 'From github.com/apps/<slug>.' },
      { key: 'GITHUB_APP_PRIVATE_KEY', label: 'Private key (.pem)', secret: true, kind: 'textarea', placeholder: '-----BEGIN RSA PRIVATE KEY-----\n…', help: 'Open the downloaded .pem file in a text editor and paste all of it.' },
      { key: 'GITHUB_APP_WEBHOOK_SECRET', label: 'Webhook secret', secret: true, generate: 'random', help: 'Generate one here, then paste the same value in the app’s webhook settings.' },
    ],
    guide: 'github_app',
  },
  {
    id: 'meta',
    title: 'Meta — Facebook & Instagram lead ads',
    unlocks: '“Connect with Facebook” for lead ads: every lead form submission becomes a lead within seconds.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'META_APP_ID', label: 'App ID', pattern: '^[0-9]{5,20}$' },
      { key: 'META_APP_SECRET', label: 'App secret', secret: true },
      { key: 'META_VERIFY_TOKEN', label: 'Webhook verify token', secret: true, generate: 'random', help: 'Any random text; paste the same value in the app’s Webhooks settings.' },
    ],
    guide: 'meta',
  },
  {
    id: 'mail',
    title: 'Platform email (Resend)',
    unlocks: 'Invitations, password resets, work-item emails, digests and statements sent by SanchalanOS itself.',
    scope: 'platform',
    testable: true,
    fields: [
      { key: 'RESEND_API_KEY', label: 'API key', secret: true, placeholder: 're_…', pattern: '^re_[A-Za-z0-9_]{8,}$' },
      { key: 'MAIL_FROM', label: 'Send as', placeholder: 'SanchalanOS <no-reply@hrpai.in>', help: 'The domain must be verified in Resend.' },
    ],
    guide: 'resend',
  },
  {
    id: 'ai',
    title: 'AI providers (fallbacks)',
    unlocks: 'Groq and Google Gemini as fallbacks when Workers AI is busy or over its daily free allowance. Workspaces can add their own keys in Settings → AI models.',
    scope: 'platform',
    testable: true,
    required: [],
    fields: [
      { key: 'GROQ_API_KEY', label: 'Groq API key', secret: true, placeholder: 'gsk_…' },
      { key: 'AI_MODEL_GROQ', label: 'Groq model', placeholder: 'llama-3.3-70b-versatile', section: 'Optional' },
      { key: 'GEMINI_API_KEY', label: 'Google Gemini API key', secret: true, placeholder: 'AIza…', help: 'On Gemini’s free tier prompts may be used by Google; SanchalanOS never sends personal data there unless you allow it.' },
      { key: 'AI_MODEL_GEMINI', label: 'Gemini model', placeholder: 'gemini-2.5-flash', section: 'Optional' },
    ],
    guide: 'ai',
  },
  {
    id: 'gst',
    title: 'GST portal, e-invoice and e-way bill (GSP)',
    unlocks: 'GSTIN look-ups, filing GSTR-1 / 3B through the GST portal, IRNs for e-invoices and e-way bills. A workspace can use its own GSP account instead.',
    scope: 'both',
    required: [],
    fields: [
      { key: 'GST_PROVIDER', label: 'Use', kind: 'select', options: [['', 'Whichever has keys (gstinapi → India Compliance → WhiteBooks)'], ['gstinapi', 'gstinapi.in'], ['indiacompliance', 'India Compliance'], ['whitebooks', 'WhiteBooks']] },
      { key: 'GSTINAPI_KEY', label: 'gstinapi.in API key', secret: true, placeholder: 'gak_…', section: 'gstinapi.in' },
      { key: 'GSTINAPI_TEST_MODE', label: 'Test mode (synthetic responses, free)', kind: BOOL, section: 'gstinapi.in' },
      { key: 'INDIA_COMPLIANCE_API_SECRET', label: 'API secret', secret: true, section: 'India Compliance' },
      { key: 'INDIA_COMPLIANCE_TEST_MODE', label: 'Test mode (e-invoice and e-way bill sandbox)', kind: BOOL, section: 'India Compliance' },
      { key: 'WHITEBOOKS_ENV', label: 'Environment', kind: 'select', options: [['sandbox', 'Sandbox'], ['production', 'Production']], section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_EMAIL', label: 'Registered email', section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_CLIENT_ID', label: 'GST API client ID', section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_CLIENT_SECRET', label: 'GST API client secret', secret: true, section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_EINVOICE_CLIENT_ID', label: 'e-invoice client ID (if different)', section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_EINVOICE_CLIENT_SECRET', label: 'e-invoice client secret', secret: true, section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_EWAYBILL_CLIENT_ID', label: 'e-way bill client ID (if different)', section: 'WhiteBooks' },
      { key: 'WHITEBOOKS_EWAYBILL_CLIENT_SECRET', label: 'e-way bill client secret', secret: true, section: 'WhiteBooks' },
    ],
    guide: 'gst',
  },
  {
    id: 'push',
    title: 'Push notifications',
    unlocks: 'Notifications on phones and desktops: web push for the installed app (VAPID) and native push for the Android app (Firebase).',
    scope: 'platform',
    testable: true,
    generatePair: 'vapid',
    required: ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY'],
    fields: [
      { key: 'VAPID_PUBLIC_KEY', label: 'VAPID public key', section: 'Web push', placeholder: 'B…' },
      { key: 'VAPID_PRIVATE_KEY', label: 'VAPID private key', secret: true, section: 'Web push' },
      { key: 'VAPID_SUBJECT', label: 'Contact', placeholder: 'mailto:support@hrpai.in', section: 'Web push' },
      { key: 'FCM_SERVICE_ACCOUNT', label: 'Firebase service-account key (JSON)', secret: true, kind: 'textarea', section: 'Android app (Firebase)', placeholder: '{ "type": "service_account", … }' },
    ],
    guide: 'push',
  },
  {
    id: 'turnstile',
    title: 'Cloudflare Turnstile (bot check)',
    unlocks: 'The bot check on public web forms, sign-up and privacy requests.',
    scope: 'platform',
    testable: true,
    fields: [{ key: 'TURNSTILE_SECRET', label: 'Secret key', secret: true, placeholder: '0x4AAAAAAA…' }],
    guide: 'turnstile',
  },
  {
    id: 'cloudflare',
    title: 'Cloudflare — workspace addresses and customer domains',
    unlocks: '<workspace>.<your domain> addresses and customers’ own domains with automatic certificates (Cloudflare for SaaS).',
    scope: 'platform',
    testable: true,
    required: [],
    fields: [
      { key: 'CF_ACCOUNT_ID', label: 'Account ID', section: 'Account', pattern: '^[0-9a-f]{32}$' },
      { key: 'CF_ZONE_NAME', label: 'Zone (domain)', placeholder: 'hrpai.in', section: 'Account' },
      { key: 'CF_ZONE_ID', label: 'Zone ID', section: 'Account', pattern: '^[0-9a-f]{32}$' },
      { key: 'CF_TENANT_DOMAINS_TOKEN', label: 'API token for workspace addresses', secret: true, section: 'Workspace addresses (Workers custom domains)' },
      { key: 'CF_SAAS_API_TOKEN', label: 'API token for customer domains', secret: true, section: 'Customer domains (Cloudflare for SaaS)' },
      { key: 'SAAS_CNAME_TARGET', label: 'CNAME target customers point to', placeholder: 'customers.hrpai.in', section: 'Customer domains (Cloudflare for SaaS)' },
    ],
    guide: 'cloudflare',
  },
  {
    id: 'android',
    title: 'Android app link',
    unlocks: 'Opens SanchalanOS links in the installed Android app (Digital Asset Links for the Trusted Web Activity).',
    scope: 'platform',
    fields: [
      { key: 'ANDROID_APP_ID', label: 'Package name', placeholder: 'in.hrpai.synapse', pattern: '^[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+$' },
      { key: 'ANDROID_CERT_SHA256', label: 'App signing certificate SHA-256', placeholder: 'AB:CD:…', pattern: '^([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2}(,([0-9A-Fa-f]{2}:){31}[0-9A-Fa-f]{2})*$' },
    ],
    guide: 'android',
  },
  {
    id: 'options',
    title: 'Platform options',
    unlocks: 'Who may sign up, when mailboxes sync, the AI allowance per workspace and which AI models are used.',
    scope: 'platform',
    options: true,
    required: [],
    fields: [
      { key: 'SIGNUP_ENABLED', label: 'Anyone may create a new workspace (self-service sign-up)', kind: BOOL },
      { key: 'MAIL_SYNC_ALWAYS', label: 'Sync mailboxes around the clock (off: 07:00–21:00 IST, saves database time)', kind: BOOL },
      { key: 'CRON_POLL_MINUTES', label: 'Minutes between background checks of mailboxes, meetings, GeM bids and statements', placeholder: '30', pattern: '^([5-9]|[1-9][0-9]|1[0-9][0-9]|2[0-3][0-9]|240)$', help: '5–240. Each check wakes the database for about 5 minutes, so 30 keeps a free Neon plan comfortable; while people use the app, checks run every 5 minutes anyway. Nights (21:00–07:00 IST) check at most every 2 hours.' },
      { key: 'AUTO_BACKUPS', label: 'Nightly backups for workspaces that turn them on (off: backups only when someone clicks "Back up now")', kind: BOOL },
      { key: 'AI_DAILY_LIMIT_PER_TENANT', label: 'AI requests per workspace per day on the platform’s AI', placeholder: '300', pattern: '^[0-9]{1,6}$' },
      { key: 'AI_PII_PROVIDERS', label: 'AI providers that may receive personal data', placeholder: 'workers-ai,groq', pattern: '^(workers-ai|groq|gemini)(,(workers-ai|groq|gemini))*$', help: 'Comma list of workers-ai, groq, gemini. Leave Gemini out while you use its free tier.' },
      { key: 'AI_MODEL_WORKERS', label: 'Workers AI chat model', placeholder: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', pattern: '^@cf/[a-z0-9._/-]+$' },
      { key: 'AI_MODEL_WHISPER', label: 'Speech-to-text model (without speakers)', placeholder: '@cf/openai/whisper-large-v3-turbo', pattern: '^@cf/[a-z0-9._/-]+$' },
    ],
    guide: 'options',
  },
];

export const ALL_KEYS: string[] = KEY_GROUPS.flatMap((g) => g.fields.map((f) => f.key));
export const keyField = (key: string): KeyField | undefined => KEY_GROUPS.flatMap((g) => g.fields).find((f) => f.key === key);
export const groupOfKey = (key: string): KeyGroup | undefined => KEY_GROUPS.find((g) => g.fields.some((f) => f.key === key));
export const requiredKeys = (g: KeyGroup): string[] => g.required ?? g.fields.filter((f) => f.kind !== 'bool' && f.section !== 'Optional').map((f) => f.key);

/* ───────────────────────────────────────── guides ───────────────────────────────────────── */

export const GUIDES: Record<string, Guide> = {
  google: {
    title: 'Create the Google OAuth client',
    links: [
      { label: 'Google Cloud console', url: 'https://console.cloud.google.com/' },
      { label: 'Google Auth Platform', url: 'https://console.cloud.google.com/auth/overview' },
      { label: 'API library', url: 'https://console.cloud.google.com/apis/library' },
    ],
    steps: [
      'Sign in to the Google Cloud console with the company Google account and create a project (for example “SanchalanOS”).',
      'APIs & Services → Library: enable the Gmail API, the Google Calendar API and the Google Meet REST API.',
      'Google Auth Platform → Branding: app name, support email, your logo and the app’s home page and privacy-policy links. Audience: “External” (or “Internal” if only your own Google Workspace will use it); while the app is in Testing add the people who will try it as test users.',
      'Data access → Add or remove scopes: gmail.readonly, gmail.send, calendar.events and meetings.space.readonly (plus openid, email, profile).',
      'Clients → Create client → Application type “Web application”. Under Authorized redirect URIs add both addresses below, exactly as shown.',
      'Create, then copy the Client ID and the Client secret into the fields here and Save. Use Test to check them.',
      'To let anyone outside the test users connect, publish the app (Audience → Publish). Gmail scopes are “restricted”: Google asks for verification and a yearly security assessment before more than 100 people can use them.',
    ],
    copy: [
      { label: 'Redirect URI — mailboxes', path: '/api/public/oauth/google/callback' },
      { label: 'Redirect URI — Google Meet', path: '/api/public/oauth/gmeet/callback' },
    ],
  },
  microsoft: {
    title: 'Register the app in Microsoft Entra',
    links: [
      { label: 'Entra admin center — App registrations', url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
      { label: 'Azure portal (same page)', url: 'https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' },
    ],
    steps: [
      'Sign in to the Microsoft Entra admin center as an admin of your Microsoft 365 tenant. Applications → App registrations → New registration.',
      'Name it “SanchalanOS”. Supported account types: “Accounts in any organizational directory and personal Microsoft accounts” (so customers’ and personal Outlook accounts can connect).',
      'Redirect URI: platform “Web”, paste the first address below. After creating, Authentication → Add URI → paste the second one → Save.',
      'Certificates & secrets → Client secrets → New client secret (24 months) → copy the Value at once (it is shown only once).',
      'API permissions → Add a permission → Microsoft Graph → Delegated: offline_access, openid, email, User.Read, Mail.ReadWrite, Mail.Send, Calendars.ReadWrite, OnlineMeetings.ReadWrite, OnlineMeetingTranscript.Read.All. Then “Grant admin consent” for your organisation.',
      'Overview: copy the Application (client) ID. Paste it and the secret value here, Save and Test.',
      'Put a reminder in the calendar a few weeks before the secret expires: create a new secret, paste it here, then delete the old one.',
    ],
    copy: [
      { label: 'Redirect URI — mailboxes', path: '/api/public/oauth/microsoft/callback' },
      { label: 'Redirect URI — Teams meetings', path: '/api/public/oauth/msmeet/callback' },
    ],
    notes: ['Customers’ IT admins may need to approve the app for their organisation the first time someone connects (transcript permission needs admin consent).'],
  },
  zoom: {
    title: 'Build a Zoom General app',
    links: [{ label: 'Zoom App Marketplace — Develop', url: 'https://marketplace.zoom.us/develop/create' }],
    steps: [
      'Sign in to the Zoom App Marketplace with your Zoom account → Develop → Build App → General App.',
      'Basic Information: choose “User-managed app”. OAuth Information: paste the redirect address below as the OAuth Redirect URL and add it to the OAuth Allow List.',
      'Scopes → Add scopes: meeting:write:meeting, meeting:read:meeting, user:read:user and cloud_recording:read:list_recording_files (transcripts come from cloud recordings).',
      'App Credentials: copy the Client ID and Client Secret (use the Development pair to try it with your own account, Production once the app is published).',
      'Paste them here, Save and Test. To let other Zoom accounts connect, submit the app for Zoom’s review or share it as an unlisted app.',
    ],
    copy: [{ label: 'OAuth redirect URL', path: '/api/public/oauth/zoom/callback' }],
    notes: ['Transcripts need a Zoom Pro (or higher) plan with cloud recording and “Create audio transcript” switched on.'],
  },
  github_app: {
    title: 'Create the GitHub App',
    links: [
      { label: 'New GitHub App (your account)', url: 'https://github.com/settings/apps/new' },
      { label: 'GitHub Apps docs', url: 'https://docs.github.com/apps/creating-github-apps' },
    ],
    steps: [
      'On GitHub: your organisation → Settings → Developer settings → GitHub Apps → New GitHub App (or the link above for a personal account).',
      'Name “SanchalanOS” (GitHub makes the slug from it). Homepage URL: this app’s address.',
      'Setup URL: paste the first address below and tick “Redirect on update”. Webhook: Active, Webhook URL = the second address, Webhook secret = press Generate here and paste the same value.',
      'Repository permissions: Checks read & write, Contents read & write (to create branches), Metadata read-only, Pull requests read-only; Administration read & write only if SanchalanOS should set branch protection. Subscribe to events: Push, Pull request, Create, Workflow run.',
      'Where can it be installed: “Any account” if customers will install it on their own organisations. Create the app.',
      'On the app’s page: copy the App ID; the slug is the last part of its public link (github.com/apps/<slug>). Private keys → Generate a private key → open the downloaded .pem and paste it here.',
      'Save and Test. Then each workspace admin installs it from Projects → Work setup → GitHub App.',
    ],
    notes: [
      'Leave “Callback URL”, “Request user authorization (OAuth) during installation” and “Device flow” alone — SanchalanOS does not sign people in with GitHub; the Setup URL is what brings an installation back.',
      'Give only the permissions listed above: no organisation or account permissions. Customers see the list when they install, and every extra permission is access you would hold to their code.',
      'GitHub cannot deliver webhooks to localhost. On your computer run a tunnel — `cloudflared tunnel --url http://localhost:8787` — and use its https address (…trycloudflare.com/api/public/github/app) as the Webhook URL; it changes each time unless you make a named tunnel on your own domain. The Setup URL may stay on localhost (your browser follows it).',
    ],
    copy: [
      { label: 'Setup URL', path: '/api/public/github/setup' },
      { label: 'Webhook URL', path: '/api/public/github/app' },
    ],
  },
  meta: {
    title: 'Create the Meta app for lead ads',
    links: [
      { label: 'Meta for Developers — My Apps', url: 'https://developers.facebook.com/apps/' },
      { label: 'Lead ads webhooks', url: 'https://developers.facebook.com/docs/marketing-api/guides/lead-ads/retrieving/' },
    ],
    steps: [
      'developers.facebook.com → My Apps → Create app. Use case “Other” → app type “Business”, linked to your business portfolio.',
      'Add the products “Facebook Login for Business” and “Webhooks”.',
      'Facebook Login → Settings → Valid OAuth Redirect URIs: paste the first address below.',
      'Webhooks → choose the “Page” object → Subscribe to this object: callback URL = the second address, verify token = press Generate here and paste the same value → Verify and save → subscribe to the field “leadgen”.',
      'App settings → Basic: copy the App ID and App secret (Show) here, fill in the privacy-policy URL and save.',
      'App Review → Permissions: request Advanced access for leads_retrieval, pages_manage_ads, pages_manage_metadata, pages_read_engagement, pages_show_list and business_management, then switch the app to Live.',
      'Save and Test here; workspaces then use Settings → Integrations → Connect with Facebook.',
    ],
    copy: [
      { label: 'OAuth redirect URI', path: '/api/public/oauth/meta/callback' },
      { label: 'Webhook callback URL', path: '/api/public/hooks/meta-leads' },
    ],
  },
  resend: {
    title: 'Set up Resend for email',
    links: [
      { label: 'Resend — Domains', url: 'https://resend.com/domains' },
      { label: 'Resend — API keys', url: 'https://resend.com/api-keys' },
    ],
    steps: [
      'Create a Resend account (free: 3,000 mails a month, 100 a day).',
      'Domains → Add domain (for example mail.hrpai.in) → add the DNS records it shows (SPF, DKIM and the return-path MX) at your DNS host — in Cloudflare DNS turn the proxy off for them — and press Verify.',
      'API Keys → Create API key → permission “Sending access”, domain = the one you verified → copy the key (shown once).',
      'Paste the key here and set “Send as” to an address on the verified domain, e.g. SanchalanOS <no-reply@mail.hrpai.in>. Save and Test.',
    ],
  },
  ai: {
    title: 'Get Groq and Gemini API keys',
    links: [
      { label: 'Groq console — API keys', url: 'https://console.groq.com/keys' },
      { label: 'Google AI Studio — API keys', url: 'https://aistudio.google.com/apikey' },
    ],
    steps: [
      'Groq: sign in to console.groq.com → API Keys → Create API Key → copy it (shown once). The free tier has per-minute and per-day limits.',
      'Gemini: sign in to Google AI Studio → Get API key → Create API key (in a Google Cloud project) → copy it.',
      'Paste either or both here and Save; Test lists the models each key can use. Leave the model fields empty for the defaults.',
    ],
    notes: ['Workers AI needs no key. Which providers may receive personal data is set by the server (AI_PII_PROVIDERS, default Workers AI and Groq).'],
  },
  gst: {
    title: 'Get GSP (GST Suvidha Provider) API keys',
    links: [
      { label: 'gstinapi.in', url: 'https://gstinapi.in/' },
      { label: 'India Compliance', url: 'https://indiacompliance.app/' },
      { label: 'WhiteBooks developer portal', url: 'https://developer.whitebooks.in/' },
    ],
    steps: [
      'Pick one provider. gstinapi.in: sign up → Dashboard → API keys → create a key (gak_…). Its test mode returns synthetic data and costs nothing — tick it while you try things.',
      'India Compliance: create an account → API → copy the API secret. Its test mode sends e-invoice and e-way bill calls to the sandbox.',
      'WhiteBooks: register on the developer portal with your business email → create applications for GST, e-invoice and e-way bill → copy each client ID and secret (sandbox first, production after their KYC). The e-invoice and e-way bill pairs can be left empty when they are the same as the GST pair.',
      'Paste the keys here and Save. Each workspace still signs in to the GST portal with its own GSTIN user name and OTP from Books → GST (and enables API access on gst.gov.in: My Profile → Manage API Access → Yes).',
    ],
    notes: ['A workspace with its own GSP account can enter its keys in its own Settings → Connection keys; they are used for that workspace only.'],
  },
  push: {
    title: 'Set up push notifications',
    links: [
      { label: 'Firebase console', url: 'https://console.firebase.google.com/' },
      { label: 'Web push (VAPID) explained', url: 'https://web.dev/articles/push-notifications-web-push-protocol' },
    ],
    steps: [
      'Web push: press “Generate key pair” here — it fills the VAPID public and private keys. Set Contact to a mailto: address of your support team and Save. Keep the pair: changing it later means everyone has to allow notifications again.',
      'Android app (only if you ship it): Firebase console → Add project (or open the one the Android app uses) → Project settings → Service accounts → Generate new private key → open the downloaded JSON and paste all of it here.',
      'Save and Test. People then turn notifications on in My account → Phone & notifications.',
    ],
  },
  turnstile: {
    title: 'Create a Turnstile widget',
    links: [{ label: 'Cloudflare dashboard — Turnstile', url: 'https://dash.cloudflare.com/?to=/:account/turnstile' }],
    steps: [
      'Cloudflare dashboard → Turnstile → Add widget. Name it, add the hostnames your forms are served from (your app host and any customer domains), mode “Managed”.',
      'Copy the Secret key here and Save; Test checks it with Cloudflare.',
      'The Site key goes into each web form that should show the check (Settings → Web forms → the form → Bot check).',
    ],
  },
  cloudflare: {
    title: 'Cloudflare tokens for addresses and domains',
    links: [
      { label: 'Cloudflare — API tokens', url: 'https://dash.cloudflare.com/profile/api-tokens' },
      { label: 'Cloudflare for SaaS', url: 'https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/' },
    ],
    steps: [
      'Account ID, zone and zone ID: Cloudflare dashboard → your domain → Overview, right-hand column (API section).',
      'Workspace addresses (<workspace>.your-domain): My Profile → API Tokens → Create Token → Custom token with Account · Workers Scripts · Edit and Zone · Workers Routes · Edit + Zone · DNS · Edit for your zone. Paste it as “API token for workspace addresses”.',
      'Customer domains: on the zone enable SSL/TLS → Custom Hostnames (Cloudflare for SaaS; the first 100 hostnames are free), set a fallback origin, and create a CNAME target (for example customers.your-domain) pointing at it. Create a token with Zone · SSL and Certificates · Edit and Zone · Zone · Read for that zone and paste it with the CNAME target.',
      'Save and Test (checks each token is active).',
    ],
  },
  options: {
    title: 'What these options do',
    links: [{ label: 'Workers AI models', url: 'https://developers.cloudflare.com/workers-ai/models/' }],
    steps: [
      'Sign-up: on lets anyone create a workspace from the sign-in page (keep Turnstile set up when it is on). Off: you create workspaces for customers.',
      'Mailbox sync: Gmail and Outlook are read every ~15 minutes between 07:00 and 21:00 IST; on reads them all night too (more database time on the free plan).',
      'AI allowance: requests per workspace per day on the platform’s AI (Workers AI, Groq, Gemini). Workspaces with their own AI keys (Settings → AI models) are not limited by it.',
      'Personal data: only the providers listed get prompts with names, phone numbers or emails; the others get only prompts without them.',
      'Models: leave empty for the defaults. Any model name from the Workers AI catalogue works; a wrong name makes AI features fall back to Groq / Gemini.',
    ],
  },
  android: {
    title: 'Link the Android app',
    links: [{ label: 'Google Play Console', url: 'https://play.google.com/console' }],
    steps: [
      'Package name: the applicationId of the Android app (for example in.hrpai.synapse).',
      'Play Console → the app → Test and release → App integrity → App signing → copy the SHA-256 certificate fingerprint of the app signing key. For a debug build use `keytool -list -v -keystore debug.keystore`. Several fingerprints can be separated by commas.',
      'Save. The address below then answers for Android, and links open in the app.',
    ],
    copy: [{ label: 'Digital Asset Links file', path: '/.well-known/assetlinks.json' }],
  },

  /* ───────────── connections a workspace makes itself ───────────── */

  razorpay: {
    title: 'Razorpay keys and webhook',
    links: [
      { label: 'Razorpay Dashboard — API keys', url: 'https://dashboard.razorpay.com/app/website-app-settings/api-keys' },
      { label: 'Razorpay webhooks', url: 'https://dashboard.razorpay.com/app/webhooks' },
    ],
    steps: [
      'Sign in to the Razorpay Dashboard (switch to Test mode first to try it). Account & Settings → API keys → Generate key → copy the Key ID and Key Secret (the secret is shown once).',
      'Choose a webhook secret (any long random text) and keep it for the next step.',
      'Press Connect Razorpay here, paste the Key ID, Key Secret and the webhook secret, Save.',
      'Razorpay: Account & Settings → Webhooks → Add new webhook → URL = the webhook address SanchalanOS shows after connecting, secret = the same webhook secret, events payment_link.paid, payment_link.partially_paid, payment_link.cancelled, payment_link.expired.',
      'Live mode: repeat with live keys after Razorpay activates your account.',
    ],
  },
  exotel: {
    title: 'Exotel API key and call flow',
    links: [{ label: 'Exotel — API settings', url: 'https://my.exotel.com/apisettings/site#api-credentials' }],
    steps: [
      'Sign in to my.exotel.com → Settings → API Settings: copy the API key, API token, Account SID and the subdomain (api.exotel.com or api.in.exotel.com for Mumbai).',
      'ExoPhones: note the virtual number calls should come from (caller ID).',
      'Press Connect Exotel here and paste them.',
      'For incoming calls: App Bazaar → your call flow → add a Passthru applet at the end with the “Incoming calls” address SanchalanOS shows.',
      'Each salesperson adds their mobile number in My account — Exotel rings them first.',
    ],
  },
  meta_leads: {
    title: 'Connect Facebook pages for lead ads',
    links: [{ label: 'Meta Business Suite — lead forms', url: 'https://business.facebook.com/latest/instant_forms' }],
    steps: [
      'You need to be an admin of the Facebook page (and the Instagram account linked to it) that runs the lead ads.',
      'Press “Connect with Facebook”, sign in, choose the pages and allow every permission asked (lead retrieval, pages).',
      'Meta Business Suite → Business settings → Integrations → Leads access: make sure “SanchalanOS” (or all CRMs) may read the page’s leads.',
      'Send a test lead with Meta’s Lead Ads Testing Tool; it appears as a lead here within seconds.',
    ],
  },
  google_leads: {
    title: 'Send Google Ads lead forms here',
    links: [{ label: 'Google Ads', url: 'https://ads.google.com/' }],
    steps: [
      'Press “Create webhook” here and copy the webhook address and the key.',
      'Google Ads → the campaign → Assets → your lead form asset → Edit → Export leads from Google Ads → Other data integration options → Webhook integration.',
      'Paste the address as Webhook URL and the key as Key → Send test data. The test lead appears here.',
    ],
  },
  mailbox: {
    title: 'Connect your mailbox',
    links: [],
    steps: [
      'My account → Email, calendar & calls → Connect Gmail or Connect Outlook.',
      'Sign in with your work account and allow reading and sending mail and the calendar.',
      'Mail with your customers is logged on their timeline from then on, and call invites are filed on the right projects.',
      'If your company uses Google Workspace or Microsoft 365, your IT admin may have to allow the “SanchalanOS” app first.',
      'More than one address (e.g. your own and sales@): press “Add another Gmail / Outlook” and sign in with the other account — sign out of the first in that window, or use a private window, so you can pick it. Each mailbox syncs; the primary one gets your meetings in its calendar and is the default “From” (the email composer lets you pick another).',
      'Sync now reads new mail at once; otherwise mail is read about every 15 minutes during the day. “Never log mail with these addresses or domains” keeps personal mail out.',
    ],
  },
  whatsapp: {
    title: 'WhatsApp Cloud API number',
    links: [
      { label: 'Meta for Developers — My Apps', url: 'https://developers.facebook.com/apps/' },
      { label: 'WhatsApp Manager', url: 'https://business.facebook.com/wa/manage/home/' },
      { label: 'Cloud API get started', url: 'https://developers.facebook.com/docs/whatsapp/cloud-api/get-started' },
    ],
    steps: [
      'developers.facebook.com → My Apps → Create app → use case “Connect with customers through WhatsApp” → link your business portfolio.',
      'WhatsApp → API Setup: add your business phone number (it must not be on the WhatsApp app) and verify it by SMS. Copy the Phone number ID and the WhatsApp Business Account ID.',
      'A permanent token: Business settings → Users → System users → Add (Admin) → Assign assets: the app (full control) and the WhatsApp account → Generate new token with whatsapp_business_messaging and whatsapp_business_management → copy it.',
      'App settings → Basic → App secret (Show) → copy. Make up a verify token (any random text).',
      'Here: Connect channel → WhatsApp → paste the phone number ID, WABA ID, token, app secret and verify token.',
      'Back in the app: WhatsApp → Configuration → Webhook: callback URL = the Inbound URL SanchalanOS shows for the channel, verify token = the same → Verify and save → Webhook fields: subscribe to “messages” (and, for project groups, “group_lifecycle_update”).',
      'App settings → Basic: App domains `hrpai.in` (your domain), Privacy policy URL, Terms of Service URL, User data deletion URL (your website pages), Category “Business and pages”, an app icon (1024×1024) → Save. Then switch the app from Development to Live at the top of the dashboard — until it is Live Meta delivers only test webhooks, not your customers’ messages.',
      'Payment: WhatsApp Manager → Billing → add a card. Replies within 24 hours of a customer’s message are free; messages you start (reminders, updates, campaigns) need an approved template and are charged per message.',
      'Templates: Settings → Channels → Templates on the channel → write one (Utility for updates, Marketing for campaigns) → it goes to Meta for approval (minutes to hours).',
      'Test: send “hi” from your phone to the business number — it shows in Inbox within seconds; reply from Inbox.',
      'A second (third…) number: add it to the same Meta app, then Connect channel again with that number’s Phone number ID (same app secret). Meta sends all numbers to the one callback URL; SanchalanOS sorts each message to the number it was sent to.',
    ],
    notes: [
      'The Data Protection Officer section of App settings is needed only for people in the EU; leave it empty (or put India as the country).',
      'Project groups (Projects → a project → WhatsApp → New project group) use WhatsApp’s Groups API: the number needs an Official Business Account, a group has at most 8 people, and only groups made through the API can be read live. Groups that already exist on a phone can be brought in with “Import an exported chat”.',
    ],
  },
  instagram: {
    title: 'Instagram Direct messages',
    links: [{ label: 'Meta for Developers — My Apps', url: 'https://developers.facebook.com/apps/' }],
    steps: [
      'The Instagram professional account must be linked to a Facebook page (Instagram → Settings → Account type and tools / Accounts Center).',
      'In your Meta app add the “Messenger” product with Instagram settings; generate a page access token for the linked page with instagram_basic, instagram_manage_messages and pages_manage_metadata.',
      'Here: Connect channel → Instagram → paste the page ID, the token, the app secret and a verify token you make up.',
      'Webhooks → Instagram object: callback URL = the channel’s Inbound URL, the same verify token → subscribe to “messages”.',
    ],
  },
  email_channel: {
    title: 'Email channel (Resend)',
    links: [{ label: 'Resend — Domains', url: 'https://resend.com/domains' }],
    steps: [
      'In Resend add and verify your sending domain (DNS records SPF and DKIM), then create an API key with Sending access.',
      'Here: Connect channel → Email → From address on that domain (e.g. Sales <sales@yourco.in>) and the API key.',
      'For replies to come back: Resend → Inbound (or your mail host’s forwarding) → forward to the channel’s Inbound URL.',
    ],
  },
  webhook_channel: {
    title: 'Generic webhook channel',
    links: [],
    steps: [
      'Endpoint URL: where SanchalanOS should POST messages (JSON). Signing secret: any random text — SanchalanOS signs each request with it (HMAC-SHA256 in the X-Synapse-Signature header) so the receiver can check it.',
      'Messages from the other side are posted to the channel’s Inbound URL.',
    ],
  },
  teams: {
    title: 'Microsoft Teams channel webhook',
    links: [{ label: 'Teams Workflows', url: 'https://support.microsoft.com/office/create-incoming-webhooks-with-workflows-for-microsoft-teams-8ae491c7-0394-4861-ba59-055e33f75498' }],
    steps: [
      'In Teams open the channel → ••• → Workflows → “Post to a channel when a webhook request is received”.',
      'Name it “SanchalanOS”, pick the team and channel → Add workflow → copy the URL it shows.',
      'Here: Connect Teams → paste the URL → choose which alerts to send → Save → Test.',
    ],
  },
  slack: {
    title: 'Slack incoming webhook',
    links: [{ label: 'Slack — create an app', url: 'https://api.slack.com/apps?new_app=1' }],
    steps: [
      'api.slack.com/apps → Create New App → From scratch → name “SanchalanOS”, your workspace.',
      'Incoming Webhooks → turn on → Add New Webhook to Workspace → choose the channel → Allow → copy the webhook URL (https://hooks.slack.com/services/…).',
      'Here: Connect Slack → paste it → choose the alerts → Save → Test.',
    ],
  },
  gchat: {
    title: 'Google Chat space webhook',
    links: [{ label: 'Google Chat webhooks', url: 'https://developers.google.com/workspace/chat/quickstart/webhooks' }],
    steps: [
      'In Google Chat open the space → the space name → Apps & integrations → Webhooks → Add webhook.',
      'Name it “SanchalanOS” → Save → copy the URL.',
      'Here: Connect Google Chat → paste it → choose the alerts → Save → Test.',
    ],
  },
  jira: {
    title: 'Jira API token',
    links: [{ label: 'Atlassian — API tokens', url: 'https://id.atlassian.com/manage-profile/security/api-tokens' }],
    steps: [
      'Sign in as the account SanchalanOS should act as (a service account is best) → Atlassian account → Security → Create and manage API tokens → Create API token → copy it.',
      'Here: Connect Jira → site (yourcompany.atlassian.net), that account’s email and the token → Save → Test.',
      'Pick the Jira project per SanchalanOS project when pushing tasks.',
    ],
  },
  azure_devops: {
    title: 'Azure DevOps personal access token',
    links: [{ label: 'Azure DevOps — personal access tokens', url: 'https://learn.microsoft.com/azure/devops/organizations/accounts/use-personal-access-tokens-to-authenticate' }],
    steps: [
      'dev.azure.com/<organisation> → User settings (top right) → Personal access tokens → New Token.',
      'Organisation: yours; expiry: up to a year; scopes: Work Items · Read & write (add Code · Read for code links) → Create → copy it.',
      'Here: Connect Azure DevOps → organisation name and the token → Save → Test.',
    ],
  },
  asana: {
    title: 'Asana personal access token',
    links: [{ label: 'Asana developer console', url: 'https://app.asana.com/0/my-apps' }],
    steps: ['Asana → My settings → Apps → Developer apps (or the console link) → Create new token → copy it.', 'Here: Connect Asana → paste it → Save → Test.'],
  },
  sharepoint: {
    title: 'SharePoint app registration',
    links: [{ label: 'Entra — App registrations', url: 'https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade' }],
    steps: [
      'Entra admin center → App registrations → New registration (single tenant) → copy the Directory (tenant) ID and Application (client) ID.',
      'Certificates & secrets → New client secret → copy the Value.',
      'API permissions → Microsoft Graph → Application: Sites.Selected (or Sites.ReadWrite.All) → Grant admin consent. With Sites.Selected, give the app write access to the one site (Graph: POST /sites/{site-id}/permissions).',
      'Here: Connect SharePoint → tenant ID, client ID, secret, the site (yourcompany.sharepoint.com:/sites/Clients) and a folder name → Save → Test.',
    ],
  },
  dynamics_bc: {
    title: 'Business Central app registration',
    links: [{ label: 'Business Central — service-to-service auth', url: 'https://learn.microsoft.com/dynamics365/business-central/dev-itpro/administration/automation-apis-using-s2s-authentication' }],
    steps: [
      'Entra admin center → App registrations → New registration → copy tenant ID and client ID; create a client secret.',
      'API permissions → Dynamics 365 Business Central → Application: API.ReadWrite.All → Grant admin consent.',
      'In Business Central search “Microsoft Entra Applications” → New → the client ID → state Enabled → add permission sets D365 BUS FULL ACCESS (or narrower) → Grant consent.',
      'Here: Connect Business Central → tenant, client ID, secret, environment (production / sandbox) and the company ID (from Companies in BC) → Save → Test.',
    ],
  },
  sap_b1: {
    title: 'SAP Business One Service Layer',
    links: [{ label: 'SAP B1 Service Layer', url: 'https://help.sap.com/docs/SAP_BUSINESS_ONE' }],
    steps: [
      'Ask your SAP partner for the Service Layer address (https://<server>:50000/b1s/v1) — it must be reachable from the internet over HTTPS with a valid certificate.',
      'Create an SAP B1 user for SanchalanOS with rights to business partners, items and sales orders.',
      'Here: Connect SAP Business One → Service Layer URL, company database, user and password → Save → Test.',
    ],
  },
  netsuite: {
    title: 'NetSuite token-based authentication',
    links: [{ label: 'NetSuite TBA', url: 'https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4247337262.html' }],
    steps: [
      'Setup → Company → Enable Features → SuiteCloud: tick REST Web Services and Token-Based Authentication.',
      'Setup → Integration → Manage Integrations → New: name “SanchalanOS”, tick Token-Based Authentication → Save → copy the consumer key and secret (shown once).',
      'Setup → Users/Roles → Access Tokens → New: the integration, a user and a role with customer, item and sales-order permissions → copy the token ID and secret.',
      'Here: Connect NetSuite → account ID (Setup → Company → Company Information; sandboxes end in _SB1) and the four keys → Save → Test.',
    ],
  },
  razorpayx: {
    title: 'RazorpayX bank feed',
    links: [{ label: 'RazorpayX — Developer controls', url: 'https://x.razorpay.com/settings/developer-controls' }],
    steps: [
      'RazorpayX dashboard → Account & Settings → Developer controls → API keys → Generate key → copy Key ID and Key Secret.',
      'Note the account number of the RazorpayX current account (or the customer identifier for RazorpayX Lite).',
      'Here: Books → Bank → Connect RazorpayX → choose the bank account to book into and paste them. Statements are fetched every day.',
    ],
  },
  tally: {
    title: 'Tally connector',
    links: [{ label: 'TallyPrime — enable ODBC / HTTP', url: 'https://help.tallysolutions.com/tally-prime-integration-using-json-1/' }],
    steps: [
      'In TallyPrime: F1 Help → Settings → Connectivity → Client/Server configuration → TallyPrime acts as “Both”, port 9000 → save, keep the company open.',
      'Here: Connect Tally → download the connector for the computer running Tally and run the command shown (it carries a one-time token).',
      'The connector pushes vouchers and masters both ways on its schedule; keep that computer on during working hours.',
    ],
  },
  dev_github: {
    title: 'GitHub webhook (without the GitHub App)',
    links: [{ label: 'GitHub webhooks', url: 'https://docs.github.com/webhooks/using-webhooks/creating-webhooks' }],
    steps: [
      'Add the connection here; copy the webhook address and the secret it shows (the secret is shown once).',
      'GitHub → the repository (or organisation) → Settings → Webhooks → Add webhook: payload URL = the address, content type application/json, secret = the secret.',
      'Events: Pushes, Pull requests, Branch or tag creation, Workflow runs → Add webhook. GitHub sends a ping that shows here.',
    ],
  },
  dev_azure: {
    title: 'Azure DevOps service hooks',
    links: [{ label: 'Azure DevOps service hooks', url: 'https://learn.microsoft.com/azure/devops/service-hooks/services/webhooks' }],
    steps: [
      'Add the connection here; copy the webhook address and the secret.',
      'Azure DevOps → Project settings → Service hooks → Create subscription → Web Hooks.',
      'Make one subscription each for: Code pushed, Pull request created, Pull request updated, Build completed. URL = the address; Basic authentication user name “synapse”, password = the secret.',
    ],
  },

  /* ───────────── more connections, described where they are made ───────────── */

  mail_intake: {
    title: 'Read a company mailbox (bills, invoices, GeM, statements)',
    links: [
      { label: 'Gmail — app passwords', url: 'https://myaccount.google.com/apppasswords' },
      { label: 'Zoho Mail — IMAP', url: 'https://www.zoho.com/mail/help/imap-access.html' },
      { label: 'Titan — IMAP settings', url: 'https://support.titan.email/hc/en-us/articles/900000215446' },
    ],
    steps: [
      'Add mailbox → pick the provider (Titan, Zoho, GoDaddy, Hostinger, Gmail, Outlook…) or “Other (IMAP)” with the server and port your mail host gives (usually port 993, TLS).',
      'User name: the full address. Password: the mailbox password — or, for Gmail and Microsoft 365 with two-step sign-in, an app password (Gmail: Google account → Security → App passwords; Microsoft: Security info → Add sign-in method → App password). On Gmail turn IMAP on: Settings → Forwarding and POP/IMAP.',
      'Choose what it reads: GeM bid alerts, bills and invoices (as drafts to approve), bank statements by mail. Save; “Sync now” reads the last messages at once, then it is read every 30 minutes during the day.',
      'PDFs with passwords (bank statements, some invoices): Books → Bank → Statement passwords — saved once, used every month.',
      'Several mailboxes can be added (accounts@, harsha@, gem@…). Milestones → “Find the mail thread” searches all of them, any date.',
    ],
    notes: ['Only the mail the mailbox is set to read is stored. A mailbox can also be your connected Gmail / Outlook (My account) instead of IMAP.'],
  },
  meeting_apps: {
    title: 'Connect Zoom, Google Meet or Microsoft Teams',
    links: [],
    steps: [
      'My account (or Calls) → Meeting apps → Connect Zoom / Google Meet / Microsoft Teams → sign in with your work account and allow access. Each person connects their own; several accounts per app are fine.',
      'Scheduling a call (Calls, a project’s Calls, a deal) then creates the meeting link in that app and sends the invites.',
      'After the meeting, the transcript is fetched (Zoom: Pro plan with cloud recording and “audio transcript” on; Meet: Google Workspace plans with transcripts, turned on in the meeting; Teams: transcription started in the meeting) and the AI writes minutes and action items onto the project.',
      'No transcript? Upload one on the call: text, .vtt, .docx (Word) or a recording.',
    ],
    notes: ['If Connect says the app is not set up, the platform admin adds its keys in Settings → Connection keys (Google, Microsoft, Zoom).'],
  },
  project_whatsapp: {
    title: 'Link customer WhatsApp chats to a project',
    links: [],
    steps: [
      'Needs a WhatsApp number connected in Settings → Channels (see its guide).',
      'Link a customer chat: pick a contact who has written to your number. Choose what the AI does: Suggest (it proposes bugs, requirements, change requests, stories, tasks, calls; someone creates each with one click), Create automatically (items it is fairly sure of become work), or Off (messages are only kept).',
      'Project group: New project group creates a WhatsApp group from your business number (Official Business Account, up to 8 people) and gives an invite link to share.',
      'A group or chat on someone’s phone: WhatsApp → the chat → ⋮ → More → Export chat (without media) → upload the .txt here with “Import an exported chat”; upload again later to add only the new lines.',
      'Suggestions appear under the chat; the chat is read again after it goes quiet for a while, or when you press Analyse.',
    ],
  },
  api_keys: {
    title: 'API keys for scripts and integrations',
    links: [],
    steps: [
      'Settings → API keys → New key: name it, choose read or read + write, and a rate limit. The key acts as you (or the person chosen): it sees and changes only what they can.',
      'Copy the key at once (syn_…): it is shown only once. Revoke it here when it is no longer needed.',
      'Call the API with the header `Authorization: Bearer syn_…` — e.g. `curl -H "Authorization: Bearer syn_…" https://<your address>/api/v1/records/lead?limit=10`. The full reference is under Developers (OpenAPI).',
      'Webhooks (Developers → Webhooks) post events (record created / updated, deal won…) to your URL, signed with HMAC-SHA256 (X-Synapse-Signature).',
    ],
    copy: [{ label: 'API base address', path: '/api/v1' }],
  },
  coding_agent_claude: {
    title: 'Connect Claude Code (desktop app or terminal)',
    links: [
      { label: 'Claude Code — MCP', url: 'https://docs.claude.com/en/docs/claude-code/mcp' },
      { label: 'Install Claude Code', url: 'https://docs.claude.com/en/docs/claude-code/overview' },
    ],
    steps: [
      'Create an API key with read + write access in Settings → API keys (it acts as you: the agent sees and changes only what you can).',
      'In a terminal: `claude mcp add --transport http sanchalan <MCP address below> --header "Authorization: Bearer syn_…" --scope user` (the desktop app uses the same settings; restart it).',
      'Check with `claude mcp list` — “sanchalan” should be connected. In Claude Code, /mcp lists its tools (next_work, request_review…).',
      'Ask: “Work the SanchalanOS queue: next_work, set up the project if needed, implement and test on a branch, request_review, wait for review_status approved, then commit, push and complete.”',
      'Review each item here: Approve — commit & push, Request changes, or Stop.',
    ],
    copy: [{ label: 'MCP address', path: '/api/v1/mcp' }],
  },
  coding_agent_codex: {
    title: 'Connect OpenAI Codex',
    links: [{ label: 'Codex — MCP servers', url: 'https://github.com/openai/codex/blob/main/docs/config.md' }],
    steps: [
      'Create an API key with read + write access in Settings → API keys.',
      'Add to `~/.codex/config.toml` (Windows: `%USERPROFILE%\\.codex\\config.toml`): `[mcp_servers.sanchalan]`, `url = "<MCP address below>"`, `bearer_token_env_var = "SANCHALAN_KEY"`.',
      'Set the key in your environment: PowerShell `setx SANCHALAN_KEY "syn_…"` (open a new terminal after), macOS / Linux `export SANCHALAN_KEY=syn_…` in your shell profile.',
      'Start Codex in any folder and ask it to work the SanchalanOS queue (next_work → implement → request_review → after approval commit, push, complete).',
    ],
    copy: [{ label: 'MCP address', path: '/api/v1/mcp' }],
  },
  coding_agent_runner: {
    title: 'Hands-free: the agent runner',
    links: [],
    steps: [
      'On the developer machine: Node 20+, git, Claude Code (`claude`) or Codex (`codex`) signed in, and the GitHub CLI (`gh auth login`) for pull requests.',
      'From the SanchalanOS repository folder, PowerShell: `$env:SANCHALAN_URL="<this address>"; $env:SANCHALAN_KEY="syn_…"; $env:AGENT="claude"; node scripts/agent/sanchalan-agent.mjs` (AGENT=codex for Codex).',
      'It waits for work; for each item it clones the project (or creates the folder when no repository is linked) into WORK_DIR (default ~/sanchalan-work), makes a git worktree on branch sanchalan/<KEY>-<title>, runs the agent, and asks for review here.',
      'After you approve it commits, pushes, opens the pull request and runs the project’s release command; Request changes sends your note back to the agent on the same branch.',
      'Options: PROJECT=FLEET (one project), ONCE=1 (one job, then stop), WORK_DIR=D:\\work, CLAUDE_ARGS / CODEX_ARGS (the agent’s permissions). Keep the runner open, or run it as a scheduled task at log-on.',
    ],
  },
  usage_costs: {
    title: 'How usage and costs are counted',
    links: [
      { label: 'Cloudflare Workers pricing', url: 'https://developers.cloudflare.com/workers/platform/pricing/' },
      { label: 'Neon pricing', url: 'https://neon.com/pricing' },
      { label: 'WhatsApp pricing', url: 'https://developers.facebook.com/docs/whatsapp/pricing' },
    ],
    steps: [
      'Every call to an outside service (AI models, email, WhatsApp / Meta, Razorpay and the bank feed, GST APIs, Google, Microsoft, Zoom, GitHub, Cloudflare), every request and background job, database queries, AI tokens and stored files are counted as they happen, per workspace and day.',
      'Cost = the price list (plan fee per month + unit prices above the free allowance, in USD or INR) × the usage; “Projected” continues this month’s pace to its end.',
      'Set the price list to your real plans (platform admins): e.g. Workers Paid $5, Neon Launch $19 plus storage, GitHub Team, WhatsApp utility ₹0.125 / marketing ₹0.88 per template message, your GSP’s price per call, and the ₹ per US$ rate on your card.',
      'Bills: the suppliers’ invoices and receipts (GitHub, Cloudflare, Neon, OpenAI, Google, Meta, Razorpay…) become bills in Books when their mail is read (Mail intake → bills) or added by hand; they show here month by month next to the estimate.',
      'Export CSV gives one row per month and service for your accountant.',
    ],
  },
  bank_statements: {
    title: 'Bank statements and feeds',
    links: [],
    steps: [
      'Books → Bank → the account → Import statement: CSV, Excel or PDF from your net banking (most Indian banks: Accounts → Statement → download for a date range).',
      'By mail: when the bank emails statements, add that mailbox in Mail intake with “bank statements” on, and save the PDF password once in Books → Bank → Statement passwords (often PAN in capitals or date of birth DDMMYYYY).',
      'Live feed: RazorpayX current accounts connect directly (Books → Bank → Connect RazorpayX — see its guide).',
      'The accounts desk then matches receipts and payments, proposes categories and GST, and asks you about the rest (Books → Accounts desk).',
    ],
  },
  dsc_signer: {
    title: 'Sign with a DSC on a USB token',
    links: [],
    steps: [
      'Plug the token in and install its driver (ePass, ProxKey, HYP2003…) from the token vendor.',
      'On that computer run the DSC signer from the SanchalanOS folder: `tools/dsc-signer/start-signer.bat` (it starts with `pnpm local` on a development machine).',
      'Organisation → Digital signatures → Pair a signer → run the command it shows (it ties the signer to this workspace address).',
      'View / sign on any PDF → Digital signature → choose the certificate and type the token PIN (it goes only to the signer on this computer). A .pfx certificate can instead be uploaded once and used from any computer.',
    ],
  },
  ai_models: {
    title: 'Use your own AI model keys',
    links: [
      { label: 'OpenAI — API keys', url: 'https://platform.openai.com/api-keys' },
      { label: 'Anthropic — API keys', url: 'https://console.anthropic.com/settings/keys' },
      { label: 'Google AI Studio', url: 'https://aistudio.google.com/apikey' },
      { label: 'Groq console', url: 'https://console.groq.com/keys' },
      { label: 'OpenRouter', url: 'https://openrouter.ai/keys' },
    ],
    steps: [
      'Create an API key with the provider (link above) and add billing there if the provider needs it.',
      'Add model → provider, key and model name (e.g. gpt-4.1-mini, claude-sonnet-4-5, gemini-2.5-flash) → Save → Test.',
      'Personal data: tick “may receive personal data” only for providers your contracts allow; prompts with names, phone numbers and emails go only to those.',
      'Order: your models are tried first, in order; “Fall back to the platform’s AI” uses the shared models (with the daily allowance) when yours fail.',
      'The assistant (✦), meeting minutes, WhatsApp analysis, bill reading and lead scoring all use these models; usage shows in Settings → Usage & costs.',
    ],
  },
};
