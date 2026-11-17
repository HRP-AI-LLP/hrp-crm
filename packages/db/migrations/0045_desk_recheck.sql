-- The accounts desk now reads IMPS/NEFT/UPI narrations properly and recognises partners by name, customers'
-- contacts, phone digits in UPI ids and billed amounts. Its earlier unsure suggestions (a "new party", or
-- a low-confidence guess) are looked at again by the next bookkeeper run; sure ones and people's own
-- decisions are kept.
update acct_proposals set status = 'stale'
 where status = 'pending' and agent = 'bookkeeper' and source <> 'person' and (kind = 'new_party' or confidence < 0.75);
