-- Card purchases are now booked as expenses (with the merchant as vendor), not as advances to a "new
-- vendor". Pending new-vendor suggestions for card lines are looked at again by the next bookkeeper run.
update acct_proposals p set status = 'stale'
  from bank_transactions t
 where p.status = 'pending' and p.agent = 'bookkeeper' and p.source <> 'person' and p.kind = 'new_party'
   and t.tenant_id = p.tenant_id and t.id = p.bank_txn_id and t.amount < 0
   and upper(t.description) ~ '^(PCA|POS|PCD|ECOM|VPS|VIN|MPS)[:/ ]';
