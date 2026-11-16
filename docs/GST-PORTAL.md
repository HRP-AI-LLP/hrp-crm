# GST portal, e-invoice and e-way bill (WhiteBooks GSP)

Synapse connects to the GST portal through a GST Suvidha Provider (GSP): **WhiteBooks** (developer.whitebooks.in). From **Billing & GST → GST portal** you can:

- see the filing calendar with what is due, overdue and filed;
- see the cash and credit (ITC) ledger balances, the liability ledger, tax payable, notices and orders, and challans;
- prepare, save and file returns with EVC or DSC:
  - GSTR-1 and GSTR-3B (built from your invoices, bills and expenses);
  - ITC-04 (from job work);
  - GSTR-2X (accepting TDS/TCS credits);
  - GSTR-9;
  - GSTR-7, GSTR-1A, GSTR-9C, GSTR-6, GSTR-8 and CMP-08 (from portal JSON);
- fetch GSTR-2B and match it against your bills;
- create payment challans.

On an invoice you can generate the **IRN** (e-invoice) and the **e-way bill**, update the vehicle, and cancel either one. The e-invoice's signed QR code and the e-way bill number are printed on the invoice.

## Setting it up

### 1. Platform keys (once per server)

Put the keys from developer.whitebooks.in → API keys in the **repo-root `.env`** (it is git-ignored). `pnpm local` passes them to the API.

```
WHITEBOOKS_ENV=sandbox            # or production
WHITEBOOKS_EMAIL=you@company.com  # the email registered with WhiteBooks
WHITEBOOKS_CLIENT_ID=…
WHITEBOOKS_CLIENT_SECRET=…
# only if WhiteBooks issued separate keys for these products:
WHITEBOOKS_EINVOICE_CLIENT_ID=…
WHITEBOOKS_EINVOICE_CLIENT_SECRET=…
WHITEBOOKS_EWAYBILL_CLIENT_ID=…
WHITEBOOKS_EWAYBILL_CLIENT_SECRET=…
```

To check the keys, run `pnpm gst:check`. It calls the public taxpayer search and prints only the status, never the keys. Add a GSTIN and a GST portal username to also request an OTP: `pnpm gst:check 09AAAAA0000A1Z5 my_gst_user`.

On a deployed Worker, set the same names as secrets with `wrangler secret put WHITEBOOKS_CLIENT_SECRET` and so on.

Sandbox and production keys are different. Sandbox keys only work with `WHITEBOOKS_ENV=sandbox`. In the sandbox, every OTP is **575757**.

### 2. The taxpayer (once per GSTIN)

1. On **gst.gov.in**, go to *My Profile → Manage API Access*.
   - Choose **Yes** and a duration (up to 30 days).
   - If asked, choose WhiteBooks as the GSP.
   - Without this, the OTP request fails.
2. In Synapse, go to **Billing & GST → GST portal**, add the registration and fill in:
   - **GSTIN** (*Look up* fills in the legal name from the portal);
   - **GST portal username**;
   - **Authorised signatory's PAN**, used for EVC;
   - whether you file **monthly or quarterly**.
3. **Connect (send OTP)**: the portal sends an OTP to the registered mobile and email. Enter it. The session lasts 6 hours and is renewed automatically while you work.

### 3. E-invoice and e-way bill (optional)

1. On **einvoice1.gst.gov.in**, go to *API Registration → Create API User → Through GSP*, choose WhiteBooks, and create a username and password.
2. Do the same on **ewaybillgst.gov.in**, under *Registration → For GSP*.
3. Enter both under **GST portal → Registration**. The passwords are stored encrypted and are never shown again.

## Filing a return

Open **Returns → Prepare a return**, or press **Prepare** on a line of the calendar.

| Step | GSTR-1 | GSTR-3B | Others |
|---|---|---|---|
| 1. Prepare | From issued invoices and credit notes | From the books' GSTR-3B working | ITC-04 from job work; GSTR-2X and GSTR-9 from the portal; the rest from portal JSON |
| 2. Save to the portal | ✓ | ✓ | ✓ |
| 3. Check status | Processed, or the portal's error report | ✓ | ✓ |
| 4. Proceed to file | ✓ (the portal builds the summary) | — | GSTR-6: submit |
| 5. Fetch summary | ✓ | ✓ (with the liability) | ✓ |
| 6. Offset liability | — | Synapse proposes it from the ledgers; you check it and send it | — |
| 7. File | EVC (OTP to the signatory) or DSC | EVC or DSC | EVC or DSC |

- **What gets filed** is the summary the portal returns, not Synapse's own figures. Read it before filing.
- **Download JSON** gives you the exact portal JSON. You can upload it by hand in the GST offline tool instead.
- A filed return keeps its **ARN**, and Synapse will not prepare it again.
- Every call is logged under **Activity**, with who made it.

### How GSTR-1 is built

| Section | What goes in it |
|---|---|
| B2B | Registered buyers, grouped by rate |
| B2CL | Inter-state invoices above ₹1 lakh to unregistered buyers |
| B2CS | The rest of the unregistered sales, net of credit notes, by place of supply and rate |
| CDNR | Credit notes to registered buyers |
| EXP | Exports, with or without IGST |
| Nil | Nil-rated invoices |
| HSN | Split into B2B and B2C |
| Documents issued | One row per number series, counting cancelled documents |

Warnings such as *missing HSN* are shown before anything is sent.

### GSTR-3B offset

Synapse reads the liability from the summary and the balances from your ledgers. Then:

- **Forward-charge tax** is paid from ITC: IGST credit first, then CGST and SGST credit. CGST and SGST credit never cross.
- **What is left**, reverse-charge tax, interest and late fee are paid from the cash ledger.

You see what the cash ledger must cover and any shortfall. If cash is short, create a challan (**Ledgers, notices & payments → Create challan**) and pay it before you offset.

### GST TDS from government buyers (GSTR-2X)

When a buyer such as FCI deducts GST TDS under section 51, the credit reaches you through GSTR-2X:

1. **Prepare a return → GSTR-2X** fetches the deductors' entries and accepts them all.
2. Save it and file it. The amount then reaches your electronic cash ledger.

See [GOVERNMENT.md](GOVERNMENT.md) for how GST TDS is booked on receipts.

## E-invoice and e-way bill on an invoice

On an issued invoice, the **E-invoice & e-way bill** panel offers these actions.

- **Generate IRN**
  - Sends the invoice's e-invoice JSON (schema 1.1) to the IRP and saves the IRN, the acknowledgement and the signed QR code.
  - If the IRN already exists, for example because it was generated on the IRP portal, Synapse fetches it.
- **E-way bill**
  - With a live IRN, it is generated through the IRP.
  - Otherwise, it is generated directly on the e-way bill system from the invoice. The invoice needs goods lines with HSN codes, and both PIN codes.
  - A distance of 0 lets the system work out the distance from the PIN codes.
- **Update vehicle** (Part B): a new vehicle, for example after a breakdown or transhipment.
- **Cancel EWB** and **Cancel IRN**: allowed within 24 hours. Cancel the e-way bill first. After cancelling an IRN, cancel the invoice in Synapse too.

## Who can do what

- Books or billing admins can use the GST portal, file returns and generate IRNs and e-way bills.
- Taxpayer search (Look up) is also open to account admins.
- Platform keys are never sent to the browser.
- The e-invoice and e-way bill passwords and the portal session are encrypted with `DATA_ENCRYPTION_KEY`, with the workspace bound in. They are never returned.

## Good to know

- **Due dates** are the regular ones. They are not adjusted for extensions; check gst.gov.in.
  - Quarterly GSTR-3B is due on the 22nd or the 24th, depending on the state.
  - The calendar marks a return filed when it was filed from Synapse, or when *Update filed returns from the portal* finds it filed.
- **The schema follows GSTN's API** (2025 format: HSN split into B2B and B2C). If WhiteBooks or GSTN change a field, the portal's error report says which one. You can also download the JSON, fix it, and upload it as portal JSON.
- **DSC filing** needs the signatory's DSC registered on the GST portal and WhiteBooks' signing utility. EVC needs nothing extra.
- **Sandbox first.** Run the whole flow in WhiteBooks' sandbox before switching `WHITEBOOKS_ENV` to production.

## API

| Area | Endpoints (under `/api/v1/gst`) |
|---|---|
| Registrations and session | `GET /connections`, `POST /connections`, `PATCH /connections/:id`, `DELETE /connections/:id`, `POST /connections/:id/otp`, `/verify`, `/disconnect` |
| Dashboard | `GET /connections/:id/overview`, `POST /connections/:id/sync-returns`, `POST /connections/:id/views/:kind` (see `GET /views`), `GET /search/:gstin` |
| Returns | `POST /connections/:id/filings`, `POST /connections/:id/filings/from-portal`, `GET /filings/:id` |
| Filing steps | `POST /filings/:id/save`, `/status`, `/proceed`, `/summary`, `/offset/propose`, `/offset`, `/reset`, `/evc-otp`, `/file` |
| GSTR-2B and payments | `POST /connections/:id/gstr2b`, `POST /connections/:id/challans` |
| Invoices | `GET /invoices/:id`, `POST /invoices/:id/irn`, `/irn/cancel`, `/eway-bill`, `/eway-bill/cancel`, `/eway-bill/vehicle` |
