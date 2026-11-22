# SanchalanOS ⇄ Tally connector

The connector is one file, [`apps/web/public/downloads/synapse-tally.mjs`](../../apps/web/public/downloads/synapse-tally.mjs). Accountants download it from **Billing & GST → Tally sync**, which also shows the connector URL and token.

It runs on the PC where Tally is open, and needs Node.js 18 or newer.

```powershell
node synapse-tally.mjs --url https://www.sanchalan.hrpai.in/api/public/tally/<key> --token tly_…
```

What it does every 10 minutes:

- imports customer ledgers, sales invoices, credit notes and receipts into Tally;
- reports to SanchalanOS what Tally accepted or rejected;
- sends back receipts entered in Tally.

See `docs/INTEGRATIONS.md` → *Tally* for setup and behaviour.
