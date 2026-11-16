# Government and tender contracts (GeM, CPPP, PSU)

This is how a contract won on GeM, CPPP or a PSU e-procurement portal runs in Synapse, from the bid to the last retention release. The worked example is a GeM order from the Food Corporation of India (FCI), with one milestone delivered.

## What Synapse adds for government buyers

| Need | Where |
|---|---|
| Mark the buyer as a government customer | Account → **Type: Government** |
| Track the bid: source GeM or tender, bid number, closing date | Deal → **Source**, **Bid / tender no.**, **Bid closes on** |
| EMD, performance security (ePBG, bank guarantee, FDR, DD, insurance surety bond) and retention money, with expiry reminders, release and forfeiture | Books → **Deposits & guarantees** |
| Contract number and date printed on every invoice | Project, sales order or invoice → **Buyer's order / contract no.** and **Order / contract date** |
| Milestone acceptance (CRAC, inspection or completion certificate) printed on the invoice | Project → Milestones → **Accepted on** and **Acceptance ref.** |
| Payments net of income-tax TDS, GST TDS (section 51), liquidated damages, retention and bank charges | **Record payment** → *The customer deducted something* |
| TDS and GST TDS to claim, and retention to collect | Books → GST & TDS; Books → Deposits & guarantees |

## Postings (when Synapse keeps the books)

| Event | Debit | Credit |
|---|---|---|
| EMD or deposit paid (online, DD, FDR, cash) | EMD and performance security with customers (customer) | Bank |
| Bank guarantee / ePBG with margin money | Margin money against bank guarantees | Bank |
| Receipt with deductions | Bank (the net); TDS receivable; GST TDS receivable (section 51); Liquidated damages and penalties; Retention money with customers; Bank charges | Receivable (the full amount settled) |
| Deposit or retention released | Bank | The deposit account (a guarantee: the margin comes back) |
| Deposit forfeited / guarantee invoked | Liquidated damages and penalties | The deposit account (a guarantee: the margin first, the bank pays the rest) |

A bank guarantee is a contingent liability. It is listed in the register, not in the ledger.

When Tally is the books of record, nothing is posted. The register still works, and receipts go to Tally with each deduction on its own ledger: *TDS Receivable*, *GST TDS Receivable*, *Liquidated Damages*, *Retention Money Receivable* and *Bank Charges*. You can rename these ledgers under Billing & GST → Settings.

## Who can do what

- **Deposits & guarantees, and deductions on receipts:** books or billing admins.
- **Milestone acceptance:** project managers.
- **Reminders:** the person who recorded a deposit, and the project manager, are notified 30 and 7 days before it expires. Extending it resets the reminders.

## Step by step: an FCI order won on GeM

### 1. Set up (once)

1. In **Settings → Apps**, switch on **Orders**, **GST billing**, **Purchasing**, **Books** and **Projects**.
2. In **Settings → Sales setup**, enter your legal name, GSTIN, state and address. In **Billing & GST → Settings**, enter the bank details printed on invoices.
3. In **Books → Settings**, choose **Synapse keeps the books** and set the books start date. If you use Tally, choose Tally instead and set up Billing & GST → Tally.
4. In **Books → Banking**, add your current account. This is where payments land and where the EMD and margin money are paid from.

### 2. The buyer

Go to **Accounts → New** and enter:

- **Name:** Food Corporation of India, plus the office named on the contract (for example "FCI Regional Office, Lucknow").
- **Type:** Government.
- **GSTIN:** the buyer's GSTIN printed on the GeM contract. The state follows from it, which decides IGST or CGST + SGST.
- **Address:** the address printed on the contract.

Add the consignee and the paying authority as **Contacts** on the account.

### 3. The bid

1. **Deals → New**:
   - **Account:** FCI.
   - **Amount:** your bid value.
   - **Source:** GeM portal.
   - **Bid / tender no.:** for example GEM/2026/B/1234567.
   - **Bid closes on:** the bid end date.
2. If the bid needed EMD, go to **Books → Deposits & guarantees → Record EMD / guarantee / deposit**:
   - **What:** EMD. **Given as:** Online transfer, FDR, DD or bank guarantee.
   - **Bid number:** the GeM bid number.
   - **Amount** and **Paid from:** your bank.
   - If you were exempt (MSE or Startup), choose **Exempted**. Nothing is posted.
3. When you win, move the deal to **Won**.

### 4. The contract

1. **Projects → New**:
   - **Customer:** FCI. **Deal:** the bid.
   - **Buyer's order / contract no.:** the GeM contract number (GEMC-…). **Order / contract date:** its date.
   - **Billing:** Fixed price, with the contract value as the fixed fee.
   - **GST % on invoices** and **SAC on invoices:** for example 18% and 998314.
   - **Start date / end date:** the delivery period.
   - **Budget:** cost, hours or revenue (optional).
2. If you supply goods as well, also create a **Sales order** with the same contract number. Delivery and stock then come from it.
3. Record the **performance security** in **Books → Deposits & guarantees**:
   - **What:** Performance security. **Given as:** ePBG (or bank guarantee / FDR).
   - **Guarantee number** and **Issuing bank**.
   - **Amount:** usually 3–5% of the contract value.
   - **Margin money blocked by your bank**, if any.
   - **Valid until** and **Claim period ends**.
   - **Project:** this project.

### 5. Plan and run the work

1. On the project's **Milestones** tab, add each payment milestone in the contract with its **amount** and **due date**. For example: "Phase 1: supply and installation at 10 depots", ₹4,00,000.
2. On **Tasks**:
   - Break each milestone into tasks with assignees, dates and estimates.
   - Link dependencies on the Gantt chart.
   - Track progress on the Board.
3. On **Team**, add your people with their bill and cost rates. Cost rates give you labour cost and margin.
4. Your team logs time on **Timesheet** (weekly grid or timer) and submits each week. You approve it under **Timesheet → Approvals**.
5. Log purchases (**Bills**) and site expenses (**Expenses**) against the project, so its profit shows on the Overview tab.
6. Record snags raised during inspection under **Issues**.

### 6. Milestone completed and accepted

1. When the consignee issues the **CRAC** on GeM (or the inspection or completion certificate), open the milestone and set:
   - **Status:** Done.
   - **Accepted by the customer on:** the CRAC date.
   - **Acceptance ref.:** the CRAC number.
2. Go to the project's **Billing** tab, tick the milestone and click **Create draft invoice**. The draft GST invoice carries:
   - the GeM contract number and date ("Buyer's order / contract");
   - the milestone line, with "Accepted: CRAC … on …" under it;
   - IGST, or CGST + SGST, from the buyer's state.
3. Check the draft and **Issue** it. If e-invoicing applies to you, generate the IRN on the IRP and record it with **Add IRN**. Then **Print / Save PDF**.
4. Upload the invoice on GeM against the CRAC.

### 7. Payment received

PFMS payments usually arrive net of deductions. On the invoice, click **Record payment**:

- **Amount settled:** the invoice total (for example ₹4,72,000).
- **Reference:** the PFMS / UTR reference. **Deposited to:** your bank.
- Tick **The customer deducted something** and enter what the payment advice shows. The **2%** buttons fill in 2% of the taxable value.
  - **Income-tax TDS** (194C or 194J).
  - **GST TDS (section 51)**: 2% of the taxable value, on contracts above ₹2.5 lakh.
  - **Liquidated damages / penalty**, if any.
  - **Retention / security withheld**, if any.
  - **Bank charges**.
- **Credited to the bank** must equal what reached your bank.

The invoice becomes **Paid**. The deductions go to their own accounts, and retention appears in **Deposits & guarantees** linked to the project.

### 8. Taxes and compliance

- **Books → GST & TDS** lists every deduction by customer.
  - Income-tax TDS: match it to Form 26AS and claim it in your return.
  - GST TDS: accept it in GSTR-2X on the GST portal. It then reaches your electronic cash ledger. When you use it to pay GST, post a journal: Dr the output GST it pays, Cr *GST TDS receivable (section 51)*.
- **GSTR-3B** includes the invoice's outward tax.

### 9. Retention, guarantees and closure

- When the buyer releases retention (often after the warranty), open the retention entry in **Deposits & guarantees** → **Release**. Enter the amount and the bank it landed in. Part of it can be released now and the rest later.
- If the buyer recovers liquidated damages from the security, choose **Forfeit / invoked** with the amount and the reason.
  - For a bank guarantee, the margin money is used first. Enter the bank that paid the rest.
- If the bank renews a guarantee, choose **Extend**. Enter the new expiry and claim dates; the reminders start again.
- When the contract ends, **Release** the performance security. The guarantee closes, and any margin money comes back.
- Check the project's **Overview** for invoiced, unbilled, labour, expenses, profit and margin.

## API

- `POST /api/v1/deposits`, `GET /api/v1/deposits`, `GET /api/v1/deposits/:id`
- `POST /api/v1/deposits/:id/release`, `/forfeit`, `/extend`, `/cancel`
- `POST /api/v1/payments` accepts `tdsAmount`, `gstTdsAmount`, `ldAmount`, `retentionAmount`, `bankCharges` and `depositAccountId`.
- Project milestones accept `acceptedOn` and `acceptanceRef`.
