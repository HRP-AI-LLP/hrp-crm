# Deals, recurring billing, organisation and signatures

How a services deal becomes its invoices, and how the company's own details and signatures are kept.

## Prices that include GST

Quotes, sales orders, purchase orders, invoices and bills have **Prices include GST**: tick it and each
line's rate is what the customer pays; the taxable value is worked back from it (₹1,200 at 18% →
₹1,016.95 taxable + ₹183.05 GST, total exactly ₹1,200). Converting a quote to an order keeps the setting;
invoicing an order keeps it too (a milestone invoice bills its share of the taxable value).

## Payment terms and subject

Invoices have **Payment terms** (Due on receipt, Net 7/15/30/45/60, Due end of the month, Due end of next
month, Custom) and a **Subject** printed above the lines. A customer's own terms are the default on its
invoices. The due date follows the terms and the invoice date (and is worked out again when the invoice is
issued); with Custom, the due date is set by hand.

## A deal's charges

A deal can list **one-time charges** (website development, a domain) and **recurring charges** (monthly
maintenance: how often, the first invoice date, how many times or until stopped), each priced before or
including GST. The deal shows the one-time total and the recurring amount per month; its **amount** is the
one-time total plus the first year of recurring.

When the deal is **won**, **Set up billing** creates, after you confirm:

- a fixed-price project for the work (with the projects app on);
- a draft invoice for the one-time charges, to check and issue;
- a recurring invoice for each schedule, issued automatically when created (or left as drafts).

Every invoice made from them carries the deal (and project), and the deal lists its invoices.

## Recurring invoices

Recurring invoices run every day on their own with GST billing switched on (Books isn't needed). A
**price change** applies from a date onward: the invoices for earlier periods keep the old price, later
ones use the new one, and the history stays on the profile (Deal → Charges & billing → Change price from…).
Billing or books admins can pause, resume or run a profile now (`/recurring-invoices`).

## Organisation

Settings → **Organisation** (admins with the "organisation" permission, and the people an admin names as
its managers; a named manager sees it in the sidebar):

- **Profile**: legal and trade name, constitution, PAN, GSTIN, TAN, LLPIN / CIN, Udyam, incorporation date,
  registered address, website, the phone and email printed on documents.
- **Phones, emails & contacts**: more numbers and addresses, branches, the company's own contact people.
- **Partners & directors**: designation, share, phone, email, PAN, DIN / DPIN, their Synapse user, and
  their personal accounts (mobile numbers, UPI ids, account numbers) — the accounts desk books money to and
  from these to the person's own ledger (see ACCOUNTS-DESK.md, Own accounts).
- **Bank accounts**: the company's current accounts with their numbers, IFSC and UPI id.
- **Signatures**.

## Signatures

Save each signatory's signature once (upload a scan or draw it) and name who may sign with it. On an
issued invoice, a quote, an order or a purchase order, **Sign as …** records who signed, when, and a hash of
what was signed (number, date, party, totals, every line). The printed document shows the signature,
"Digitally signed" with the time, and a verification link; anyone can open it to see whether the
document is still exactly what was signed. A signature can be withdrawn with a reason.

Billing can sign every invoice when it is issued (Organisation → Signatures → "Sign every invoice when it
is issued with"), including recurring invoices issued on their own. Invoices imported from elsewhere are
not signed again.

This is a signature image with a tamper check, not a DSC (class 3 certificate) signature embedded in the
PDF.

## Importing past invoices

The invoice import reads "Tax inclusive" invoices, the subject, the P.O. number and the payment terms. An
invoice billed to a person on behalf of an organisation (Ms. Shalini Pathak for the NGO the subject names)
goes to that organisation with the person as its contact, and is linked to the customer's deal and to the
recurring invoice it was one of.

## API

| | |
| --- | --- |
| Deal charges | `GET /api/v1/deals/:id/charges`, `PUT /api/v1/deals/:id/charges` (`charges`), `POST /api/v1/deals/:id/setup-billing` (`project`, `oneTimeInvoice`, `autoIssue`, `startDate`) |
| Recurring invoices | `GET /api/v1/recurring-invoices`, `POST /api/v1/recurring-invoices/:id/{pause,resume,run}`, `POST /api/v1/recurring-invoices/:id/price-changes` (`effectiveFrom`, `lines`, `taxInclusive`, `note`), `DELETE /api/v1/recurring-invoices/:id/price-changes/:from` |
| Lines | every `PUT …/lines` takes `taxInclusive` |
| Organisation | `GET/PUT /api/v1/organisation`, `GET/POST /api/v1/organisation/people`, `PUT/DELETE /api/v1/organisation/people/:id`, `POST /api/v1/organisation/bank-accounts`, `PUT /api/v1/organisation/bank-accounts/:id` |
| Signatures | `GET/POST /api/v1/organisation/signatures`, `PUT/DELETE /api/v1/organisation/signatures/:id`, `GET /api/v1/documents/:object/:id/signatures`, `POST /api/v1/documents/:object/:id/sign` (`signatureId`), `POST /api/v1/documents/:object/:id/signatures/:sid/revoke` (`reason`), public `GET /api/public/verify/:tenant/:code` |

## Document templates

Settings → Company → **Document templates** (also Organisation → Document templates) holds any number of
designs for invoices, quotes, sales orders, purchase orders and credit notes. Whoever can manage the
organisation (an admin with the Organisation area, or a designated manager) can create, copy, delete and
choose the default per document kind ("Use for…"). Every document Synapse prints, shares, emails or signs
uses the default for its kind; the print page has a template picker to try another one.

A template starts from one of:

| Base | What it is |
| --- | --- |
| Classic / Modern / Compact / GST detailed | Built-in designs. Colours, font and size, logo and its side, which blocks show (company header, GST summary, amount in words, bank details, UPI QR, signature block), which columns show, the labels ("Tax invoice", "Bill to"…), notes, terms and footer are all editable with a live preview. |
| Your letterhead | Upload an A4 image or PDF of your letterhead (header and footer on a blank page). It becomes the background of every page and the document is laid out inside the top/bottom/left/right margins you set. The design controls above still apply on top of it. |
| HTML template | Your own HTML and CSS, uploaded as a file or written in the editor, with `{{placeholders}}` (Mustache): `{{number}}`, `{{customer.name}}`, `{{#lines}}…{{/lines}}`, `{{total}}`… — the editor lists them all. Scripts and external content are stripped; it renders in an isolated box. |
| Design with AI | Describe the look ("minimal, teal, logo right, GST per line") and optionally add your letterhead; the AI proposes a design (or HTML), which you then adjust and save. |

## Digital signature certificates (DSC)

Organisation → **Digital signatures (DSC)**. Invoices, sales orders and purchase orders can be signed with a
Class 3 DSC from the document's Signatures panel ("Sign with DSC: name"). Synapse draws the document in its
default template as an A4 PDF, signs it (PAdES-style detached CMS, SHA-256, a visible stamp with the
verification link on the last page), verifies the result, stores the signed PDF in the record's Files and
records the signature (who, when, certificate, hash). Anyone can check a signed PDF at `/verify/<workspace>`
or by its code; Adobe Reader shows it as signed (it trusts the issuer once the CCA India root is trusted).

Two ways to hold the certificate — both sign only from Synapse:

- **.pfx / .p12 file** — upload it with its password. Both are encrypted (AES-GCM, workspace-bound) and can
  never be downloaded again; removing the certificate deletes them. Choose who may sign with it.
- **USB token (ePass, ProxKey, mToken, WatchData…)** — the key never leaves the token. Run the small signer in
  `tools/dsc-signer` on the computer with the token (Python 3.10+, `pip install -r requirements.txt`):
  1. Organisation → Digital signatures → **Pair a signer**; run the shown `python dsc_signer.py pair …` once.
  2. Start it with `start-signer.bat` (or `python dsc_signer.py serve --lib <driver .dll>`), plug in the token.
  3. **Add the token's certificate** reads it from the token (PIN if the token needs it) and registers it.
  4. On a document, "Sign with DSC (token)" asks for the PIN; the PIN goes only to the signer on this computer.
  The signer listens on `127.0.0.1` only, answers only the paired Synapse address, and signs only with a
  ticket Synapse issued for that exact PDF (hash and length), certificate and user, valid 10 minutes. Synapse
  checks the returned file: original bytes untouched, signature valid, same certificate, whole file covered.

Limits: the signed PDF is a picture of the document (text is not selectable); the PDF to sign can be up to
about 15 MB; a timestamp from a TSA is not added yet (the signing time is the signer's clock).
