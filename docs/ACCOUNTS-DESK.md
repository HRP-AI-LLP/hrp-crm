# The accounts desk

Books → **Accounts desk** is a small department of agents that keeps the books complete. They do the routine work; you approve what they are not sure about. Ledgers, trial balance, P&L, balance sheet and cash flow come from the same double-entry books as before (Books → Reports); the desk makes sure everything that happened in the bank is in them.

| Agent | What it does |
| --- | --- |
| 🏦 Bank clerk | Pulls new transactions from live bank feeds (RazorpayX) and Razorpay gateway settlements. Statement uploads land here too. Duplicates are skipped. |
| 📒 Bookkeeper | For every bank line, works out what it is: a match to an entry already posted, a **customer receipt** against an open invoice (including receipts short by TDS), a **bill payment**, a **Razorpay settlement** (net + fee + GST on the fee against the gateway clearing account), or a **category** (from your bank rules, how the same payee was booked before, common Indian bank narrations, and last the AI model). |
| 🧾 Compliance clerk | GST and TDS: GSTR-2B invoices not in the books (ITC waiting) and mismatches, TDS deducted but not deposited (due the 7th), GST returns overdue or due within five days, bank lines nobody booked for two weeks. |
| 📊 Controller | Month-end close: unbooked bank lines, accounts not reconciled, draft documents, amounts in "Uncategorised expense", online collections not yet settled, depreciation, trial balance; the month's income, expenses, net profit against the previous month, cash, assets and liabilities, and a short note. |

## Findings come with the fix

Every finding says how to resolve it, in steps, with buttons that do it there and then. Examples:

- **GSTR-2B: supplier invoices not in your books** → *Match with books again* (free) or *Enter N as bills* (one posted bill per invoice; new suppliers added from their GSTIN; asks first). Credit notes and lines without ITC are explained.
- **Bank lines not booked** → review the suggestions, or **Book by payee**: lines grouped by who was paid / who paid you, booked a whole group at a time to an account, or as receipts from / payments to a customer or vendor (new or existing) kept as advances; *Always* turns the choice into a bank rule.
- **The books and the statement disagree** → the controller explains the difference: lines not booked yet, the balance brought forward before the books started (*Bring the opening balance from the statement* posts it against Opening balance adjustments), and anything left over. When they agree, it **reconciles the account by itself**.
- **TDS to deposit** → the amount per section and due date, how to pay ITNS-281, interest if late, the 26Q return.
- **GST return due** → how to prepare, offset and file it, late fee if late.
- **Depreciation not run** → *Run depreciation up to the month end*.

After a fix the agent looks again, and the finding clears when it is resolved.

## When nothing in the books explains a bank line

The bookkeeper proposes creating what is missing — a **new customer** for money received (kept as an advance until the invoice is raised and the receipt allocated) or a **new vendor** for money paid (an advance until the bill is entered) — named from the narration. These always wait for approval, and the name and the choice can be changed first (*Change* → Customer / Vendor advance, existing or new). If it was something else (capital, a loan, an expense), book it to that account instead.

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
| Findings | `GET /desk/findings?status=` (each with `resolution`: steps and actions), `POST /desk/findings/:id` (`status`: done, dismissed, open), `POST /desk/findings/:id/fix` (`action`) |
| Book by payee | `GET /desk/unbooked`, `POST /desk/unbooked/book` (`txnIds` with `accountId` + optional `rule`, or `advance`: customer / vendor, existing or new) |
| Feeds | `GET /feeds`, `POST /feeds`, `PATCH /feeds/:id`, `DELETE /feeds/:id`, `POST /feeds/:id/sync` |
| Statements | `POST /bank-accounts/:id/statement` with `toDesk: true` hands the new lines to the bookkeeper |
