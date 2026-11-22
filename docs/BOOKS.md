# Books (accounting)

Books is a built-in app (Settings → Apps) that turns SanchalanOS into a full double-entry accounting system for Indian businesses, in the same territory as Zoho Books and Tally. It needs **GST billing** and **Purchasing** switched on.

## Books of record: SanchalanOS or Tally

Each workspace chooses one (Books → Settings):

| | SanchalanOS keeps the books | Accountant keeps the books in Tally |
|---|---|---|
| Journals | Posted automatically from every invoice, credit note, receipt, write-off, bill, vendor credit, vendor payment, expense and reimbursement | Not posted |
| Reports | Trial balance, P&L, balance sheet, cash flow, ledgers, GSTR-3B and the rest come from the ledger | GST and receivable reports from documents; the accountant's reports in Tally |
| Tally sync | Optional | Billing → Tally pushes vouchers and pulls receipts |

Switching posting on posts every document dated on or after the **books start date**. Earlier balances go in as **opening balances** (one journal dated the day before the start, balanced by *Opening balance equity*). The start date cannot move once documents are posted.

## The ledger

- **Chart of accounts:** about 80 accounts for Indian businesses, set up automatically. These include input and output CGST/SGST/IGST, TDS receivable and payable, RCM payable, stock, work in progress and material with job workers, fixed assets, depreciation, GST not claimable and round-off. *System* accounts used by automatic postings keep their type and cannot be deleted. Add your own accounts and sub-accounts with codes.
- **Double entry, enforced by the database:**
  - A deferred constraint rejects any journal whose debits and credits differ.
  - Posted lines can never be edited or deleted; the application database role has no `DELETE` on journals.
  - A journal is corrected by **voiding** it. Documents re-post themselves when they change.
  - A unique index keeps one live journal per document.
- **Re-posting is idempotent:** a document whose entry would not change keeps its journal, so the day book has no void-and-repost churn. An entry already reconciled with a bank statement cannot change until that reconciliation is undone. A statement line matched to an entry that changes goes back to "to match".
- **Lock date:** nothing dated on or before it can be posted, changed or voided. Set it after filing returns.
- **Manual journals** use the JV/yy-yy/nnnn series. Lines on receivable or payable accounts need the customer or vendor. Manual journals can be reversed on another date or voided.

## What posts where

| Document | Debit | Credit |
|---|---|---|
| Tax invoice | Receivable (customer) | Sales or service income, output GST, round-off; plus COGS against stock for tracked goods at moving-average cost |
| Credit note | The reverse of the invoice | |
| Receipt | Bank or cash (amount − TDS − charges), TDS receivable, bank charges | Receivable at each invoice's own rate; FX difference to exchange gain/loss |
| Receipt deductions (government buyers) | GST TDS receivable (section 51), Liquidated damages and penalties, Retention money with customers | — (part of the receipt; see GOVERNMENT.md) |
| Deposit / guarantee placed, released, forfeited | See [GOVERNMENT.md](GOVERNMENT.md) | |
| Write-off | Bad debts | Receivable |
| Bill | Stock (tracked goods), the line's account or Purchases; input GST (if ITC-eligible, otherwise into cost) | Payable (net of TDS), TDS payable; for reverse charge also RCM payable |
| Vendor payment | Payable at the bills' rates; FX difference | Bank, cash or card |
| Expense (company-paid) | Category account, input GST if eligible | Paid-through account |
| Claim (approved) | Category account, input GST if eligible | Employee payable (the person) |
| Reimbursement | Employee payable | Bank or cash |
| Depreciation run | Depreciation | Accumulated depreciation |
| Asset sale or scrap | Accumulated depreciation, bank, loss | Asset cost, gain |

## Payables

- **Bills and vendor credits:**
  - Lines use the same editor as invoices; each line may post to its own account.
  - CGST + SGST or IGST is chosen from the vendor's state against yours.
  - Reverse charge and "no input credit" are per bill.
  - TDS by section: 194C, 194J, 194H, 194I, 194Q, 194A, 194O and 194M, with the section rate or your own.
  - The vendor's bill number is unique per vendor and is used for GSTR-2B matching.
- **Approvals:** bills follow approval rules like purchase orders.
- **From purchase orders:** "Create bill" copies the PO lines.
- **Item costs:** posting a bill updates the purchase price and moving average cost of stocked items.
- **Vendor payments** are applied to chosen bills, the oldest first, or kept as an advance. They can be voided.
- **Vendor credits** are applied to open bills of the same vendor.
- **Payables ageing** has buckets for current, 1–30, 31–60, 61–90 and 90+ days.

## Expenses and claims

- Anyone can file their own expenses. Sales managers see and approve their team's.
- **Company-paid expenses** are recorded at once.
- **Claims** go through submit → approve or reject (with a reason) → reimburse. Nobody approves their own claim. Only books admins reimburse.
- GST is worked out from the amount (inclusive or exclusive). Approved expenses cannot be edited; void and re-enter instead.
- The person is notified when a claim is approved, rejected or reimbursed.

## Banking

- **Accounts:** every bank, cash, card and wallet account. Each shows its balance in the books, the statement balance, the cleared balance and the number of lines left to match.
- **Statement import (CSV):**
  - Columns are detected from the header (date, narration or description, reference, amount or debit/credit, balance).
  - Dates may be `dd/mm/yyyy`, `dd-Mon-yy` or ISO.
  - Re-importing the same file adds nothing; each line has a hash.
- **Matching:**
  - The suggested match is a posted entry on that account with the same amount within 15 days.
  - Auto-match takes the single candidate within 3 days.
  - **Rules** post lines whose description contains some text to an account (optionally a customer or vendor).
  - Anything else can be categorised by hand or excluded.
- **Transfers** move money between your own accounts.
- **Reconciliation:**
  - Tick the cleared entries up to the statement date.
  - It completes only when the cleared balance equals the statement's closing balance.
  - The last reconciliation can be undone.

## Reports

All reports can be exported to CSV (formula-safe) or printed:

- Profit and loss, with an optional comparison against last year
- Balance sheet, showing current-year earnings and retained earnings without a year-end closing entry
- Cash flow (indirect method), cross-checked against the cash and bank movement
- Trial balance
- General ledger for any account, optionally filtered to one party
- Day book
- Customer and vendor statements
- Sales by customer and by item, with cost
- Purchases by vendor and by item
- Expenses by category
- Payables ageing
- Budget vs actual
- GSTR-3B summary:
  - Outward supplies, zero-rated, nil/exempt and reverse-charge inward supplies
  - Input tax credit from bills, expenses and RCM
  - Set-off in the Section 49 order: IGST credit first, then CGST and SGST credit cross-utilised against IGST
  - Tax payable in cash and credit carried forward
- GSTR-2B reconciliation:
  - Import the portal's JSON (B2B and CDNR).
  - Lines are matched to bills by supplier GSTIN and normalised invoice number.
  - The result lists matches, differences, supplier invoices missing from the books, and bills the supplier has not filed.
- TDS:
  - Deducted on bills, by section, with each vendor's PAN and the deposit due date (the 7th of the next month).
  - TDS deducted by customers on receipts, to claim against Form 26AS.

## Planning and assets

- **Budgets:** monthly amounts (April–March) per income or expense account, optionally per project, compared with actuals.
- **Fixed assets:**
  - Register, then depreciate by straight line (life or rate) or written-down value. The first month is pro-rata.
  - Depreciation runs month by month up to a chosen month end, and one journal is posted per run.
  - A run can be undone exactly: the asset register remembers what each run charged.
  - On sale or scrap, depreciation is brought up to date and the gain or loss is booked.
- **Recurring:**
  - Invoices, bills and expenses ("Make recurring" on the document) and journals repeat weekly, monthly, quarterly, half-yearly or yearly.
  - Each repeat is created as a draft, or issued or posted automatically.
  - The daily job catches up at most 12 missed runs per profile. A failure is shown on the profile and does not stop the others.
- **Exchange rates** per currency and date. Foreign-currency invoices and bills post at their own rate, and receipts and payments book the realised gain or loss.

## Permissions

| Who | Can |
|---|---|
| **Accountant** role (added when Books is switched on) | Everything in Books |
| Anyone with the `books` admin area | Ledger, banking, reports, settings, write-offs, reimbursements |
| Bills, vendor payments, expenses | Follow object permissions (own / team / all) like other records |
| Sales reps | Their own expenses and claims |
| Sales managers | Their team's expenses and claims; they can approve their team's claims |
| Read-only | No expenses |

## API

Everything is under `/api/v1/books/…` (see the workspace OpenAPI on the Developers page). Examples:

- `GET /books/reports/{trial-balance|profit-and-loss|balance-sheet|cash-flow|general-ledger|day-book|…}?from=&to=&format=csv`
- `POST /books/journals`
- `POST /books/bank-accounts/:id/statement`
- `POST /books/bills/:id/post`
- `POST /books/vendor-payments`
- `POST /books/expenses/:id/{submit|approve|reject|record|reimburse|void}`
- `PUT /books/settings`
