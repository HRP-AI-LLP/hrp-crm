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
- **USB token (ePass, ProxKey, mToken, WatchData…)** — the key never leaves the token. The small signer in
  `tools/dsc-signer` runs on the computer with the token and needs only Python 3.10+ and the token
  driver (it uses Python's own ctypes; nothing to install). `pnpm local` / `pnpm local:cloud` start it in
  the background; elsewhere `start-signer.bat`.
  1. Organisation → Digital signatures → **Pair a signer**; run the shown `pnpm dsc pair <code>` once.
  2. Plug in the token; **Add the token's certificate** reads it from the token (PIN if the token needs it).
  3. On a document, "Sign with DSC (token)" asks for the PIN; the PIN goes only to the signer on this computer.
  Synapse prepares the PDF and the digest to sign; the signer signs only that digest, with a ticket.
  The signer listens on `127.0.0.1` only, answers only the paired Synapse address, and signs only with a
  ticket Synapse issued for that exact PDF (hash and length), certificate and user, valid 10 minutes. Synapse
  checks the returned file: original bytes untouched, signature valid, same certificate, whole file covered.

Limits: the signed PDF is a picture of the document (text is not selectable); the PDF to sign can be up to
about 15 MB; a timestamp from a TSA is not added yet (the signing time is the signer's clock).

## Organisation documents and Startup India

Organisation → **Documents** keeps the registration papers of the organisation (PAN, TAN, GST, certificate of
incorporation, LLP agreement / partnership deed, MoA–AoA, Udyam, Startup India (DPIIT), 80-IAC and section 56
exemptions, IEC, shops and establishment, professional tax, trademark, address proof, bank letter, others)
and of each partner or director (PAN, Aadhaar, DIN, passport, address proof, photograph, bank letter) with
number, issue date, validity (expired / renew-within-30-days flags) and the uploaded copy (image, PDF or
Office file up to 25 MB; replacing a copy deletes the old one). Numbers with a fixed shape are checked;
the number is pre-filled from the profile. Only the profile's managers see them; copies are served by
15-minute signed links, never through the generic file routes. Deleting a partner deletes their documents.

The profile has a **Startup India** section: DPIIT recognition number (DIPP…) and date, sector, industry,
80-IAC certificate and first year claimed, and the section 56 (angel tax) exemption.

## People onboarded: PAN, Aadhaar, UAN, PF

Wherever a person is onboarded — a partner or director (Organisation → Partners & directors) or a team
member (Settings → Users: the invite form, and "ID and statutory details" on each user) — the form has an
**ID and statutory details** section: PAN, Aadhaar, UAN (EPFO) and the PF member number, each with an
upload for its copy (PAN card, Aadhaar, UAN card / EPFO letter, PF nomination). The same copies are listed
under Organisation → Documents (partners and team members each get a group with a checklist).

- Aadhaar is checked (12 digits, Verhoeff check digit), stored encrypted and shown as `XXXX XXXX 1234`;
  "Show" reveals it and writes an audit-log entry. A document entry for an Aadhaar copy keeps only the last
  four digits as its number.
- UAN must be 12 digits; the PF number is normalised to `MH/BAN/0012345/000/0001234`.
- Who sees them: admins who manage users and the organisation profile's managers (team members), the
  profile's managers (partners). People do not see one another's.
