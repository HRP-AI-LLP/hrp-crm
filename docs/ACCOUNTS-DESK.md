# The accounts desk

Books → **Accounts desk** is a small department of agents that keeps the books complete. They do the routine work; you approve what they are not sure about. Ledgers, trial balance, P&L, balance sheet and cash flow come from the same double-entry books as before (Books → Reports); the desk makes sure everything that happened in the bank is in them.

| Agent | What it does |
| --- | --- |
| 🏦 Bank clerk | Pulls new transactions from live bank feeds (RazorpayX) and Razorpay gateway settlements. Statement uploads land here too. Duplicates are skipped. |
| 📒 Bookkeeper | For every bank line, works out what it is: a match to an entry already posted, a **customer receipt** against an open invoice (including receipts short by TDS), a **bill payment**, a **Razorpay settlement** (net + fee + GST on the fee against the gateway clearing account), or a **category** (from your bank rules, how the same payee was booked before, common Indian bank narrations, and last the AI model). |
| 🧾 Compliance clerk | GST and TDS: GSTR-2B invoices not in the books (ITC waiting) and mismatches, TDS deducted but not deposited (due the 7th), GST returns overdue or due within five days, bank lines nobody booked for two weeks. |
| 📊 Controller | Month-end close: unbooked bank lines, accounts not reconciled, draft documents, amounts in "Uncategorised expense", online collections not yet settled, depreciation, trial balance; the month's income, expenses, net profit against the previous month, cash, assets and liabilities, and a short note. |

## How much the agents do on their own (Settings)

- **Book the sure ones, ask about the rest** (default): your bank rules, exact matches (≥ 95%: amount equals the open balance and the invoice / bill number, the party's name or the settlement UTR is in the narration) and payees always booked the same way (≥ 90%) are posted. Everything else — keyword and AI guesses, ambiguous matches — waits in the **Review queue**.
- **Suggest only**: nothing is posted until someone approves it.
- **Book everything above the threshold**: every suggestion at or above the confidence you set is posted; you review afterwards.

In the review queue: **Approve**, **Change** (say what it really is — a receipt against another invoice, a bill payment, an account; optionally *always book lines containing …* which creates a bank rule) or **Reject** (that suggestion is never offered again for the line). Select the 90%+ ones and approve them together. The bookkeeper learns from what you book: the next line from the same payee is suggested the same way. Anything booked can be undone in Banking (un-match / un-categorise; receipts and payments can be voided).

## Where bank transactions come from

- **Statements**: Accounts desk → Bank feeds & statements → choose one or many files at once — PDF, Excel (.xls / .xlsx) or CSV exactly as net banking gives them. The header row is found by itself (Yes Bank, ICICI, HDFC, SBI, Axis, Kotak layouts: Debit/Credit, Withdrawal/Deposit, Amount with Dr/Cr, Excel dates). PDFs are read in the browser: the table is rebuilt from the text positions, wrapped narrations are joined, and a password-protected statement opens with the password typed next to it (never stored or sent). Scanned (image) PDFs have no text and are refused. Lines repeated across overlapping files are dropped. Preview, then import: the bookkeeper runs straight away. Banking's own import takes several files and PDFs too, and still applies rules and exact matches as before.
- **RazorpayX** (business banking current account or RazorpayX Lite): Connect a feed with the account number and an API key (RazorpayX dashboard → Developer controls → API keys). The bank clerk syncs daily; *Sync now* any time.
- **Razorpay payment gateway**: connect Razorpay under Settings → Integrations (it also powers payment links). With books on, online receipts go to *UPI / payment gateway clearing*; the bank clerk fetches settlements and the bookkeeper books each payout when it appears in the bank.
- **ICICI / HDFC / Axis / Kotak APIs**: these need the bank to approve API access for your current account (and usually a fixed server IP). Once approved, a connector plugs into the same feed interface (`services/books/feeds.ts`).
- **Account Aggregator** (Decentro, Setu, Finvu…): only for entities regulated by RBI, SEBI, IRDAI or PFRDA, so not available to an ordinary business.

## The daily round

Every day (03:17 UTC) for workspaces that use the desk: bank clerk → bookkeeper → compliance clerk; in the first week of a month the controller closes the previous month once. *Run the desk now* does the same on demand; *Close this month* runs the controller for any month.

## API

All under `/api/v1/books`, books admins only.

| | |
| --- | --- |
| Desk | `GET /desk`, `PUT /desk/settings`, `POST /desk/run` (`agents`, `period`), `GET /desk/runs` |
| Review | `GET /desk/proposals?status=pending\|done\|all`, `POST /desk/proposals/:id` (`decision`, `change`, `makeRule`), `POST /desk/proposals/approve` (`ids`), `GET /desk/open-documents` |
| Findings | `GET /desk/findings?status=`, `POST /desk/findings/:id` (`status`: done, dismissed, open) |
| Feeds | `GET /feeds`, `POST /feeds`, `PATCH /feeds/:id`, `DELETE /feeds/:id`, `POST /feeds/:id/sync` |
| Statements | `POST /bank-accounts/:id/statement` with `toDesk: true` hands the new lines to the bookkeeper |
