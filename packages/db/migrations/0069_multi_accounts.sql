-- Several accounts per integration: a person may connect more than one Gmail / Outlook mailbox
-- (one is their primary: calendar mirroring and the default "From"), and a workspace may keep more
-- than one Razorpay or Exotel account (one is the default for new payment links / calls; webhooks
-- already reach each account by its own route key). Each address / account stays connected once
-- per workspace (unique tenant, provider, account_ref).
drop index if exists integrations_one_mailbox_per_person;
