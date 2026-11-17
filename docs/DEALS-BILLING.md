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
