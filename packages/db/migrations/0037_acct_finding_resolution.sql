-- 0037: each accounts-desk finding carries how to resolve it: the steps in plain words and the
-- actions the screen offers (fix it here, open the right page), written by the agent that found it.
alter table acct_findings add column resolution jsonb;

-- the bookkeeper may also propose creating what is missing: a new customer (money in, kept as an
-- advance until the invoice exists) or a new vendor (money out, an advance until the bill exists)
alter table acct_proposals drop constraint acct_proposals_kind_check;
alter table acct_proposals add constraint acct_proposals_kind_check check (kind in ('match', 'receipt', 'vendor_payment', 'categorize', 'exclude', 'settlement', 'new_party'));
alter table acct_proposals drop constraint acct_proposals_source_check;
alter table acct_proposals add constraint acct_proposals_source_check check (source in ('rule', 'ledger', 'invoice', 'bill', 'gateway', 'history', 'keyword', 'ai', 'person', 'missing'));
