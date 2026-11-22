/** Mailed receipts in layouts the rules don't know (GitHub): the buyer line is never the supplier, and the AI fills the gaps. */
import { describe, expect, it } from 'vitest';
import { mergeAiRead, weakRead } from '../src/services/intake/ai-read';
import { readReceipt } from '../src/services/intake/receipt';

const github = [
  'GitHub, Inc.',
  '88 Colin P Kelly Jr Street, San Francisco, CA 94107, United States',
  'Payment Receipt for HRP-AI-LLP',
  'Date 2026-11-21',
  'Account billed HRP-AI-LLP (info@hrpai.in)',
  'Payment method Visa **** 9814',
  'Transaction ID 7HX29031AB',
  'Item\tAmount',
  'GitHub Copilot Business (2 seats)\t$38.00',
  'Total $38.00 USD',
].join('\n');

describe('mailed receipts', () => {
  it('never takes our own name (any spelling) or the "Account billed" line as the supplier', () => {
    const r = readReceipt(github, ['HRP AI LLP']);
    expect(r.supplier.name).toBe('GitHub, Inc.');
    expect(r.currency).toBe('USD');
    expect(r.total).toBe(38);
    const noName = readReceipt(github.replace('GitHub, Inc.\n', ''), ['HRP AI LLP']);
    expect(noName.supplier.name).toBeNull();
  });

  it('fills only what the rules missed with what the AI read', () => {
    const read: Record<string, any> = {
      v: 5,
      text: github,
      data: { number: null, date: '2026-11-21', lines: [], total: null },
      receipt: { currency: 'USD', number: null, date: '2026-11-21', supplier: { name: null, country: 'United States', foreign: true, taxId: null }, total: null, subtotal: null, tax: null, paid: true, lines: [] },
      confidence: 0.4,
    };
    expect(weakRead(read)).toBe(true);
    mergeAiRead(
      read,
      {
        supplier: 'HRP-AI-LLP', // the AI confusing the buyer is ignored
        supplierCountry: 'United States',
        supplierTaxId: null,
        invoiceNumber: '7HX29031AB',
        date: '2026-11-22', // the rules' date stays
        currency: 'USD',
        lines: [{ description: 'GitHub Copilot Business (2 seats)', hsnSac: null, qty: 2, unitPrice: 19, amount: 38, taxPct: null }],
        subtotal: 38,
        tax: 0,
        total: 38,
        paid: true,
        paidOn: '2026-11-21',
        amountPaid: 38,
      },
      ['HRP AI LLP'],
    );
    expect(read.receipt.supplier.name).toBeNull();
    expect(read.data).toMatchObject({ number: '7HX29031AB', date: '2026-11-21', total: 38, lines: [{ description: 'GitHub Copilot Business (2 seats)', qty: 2, rate: 19, amount: 38 }] });
    expect(read.receipt).toMatchObject({ total: 38, number: '7HX29031AB', paidOn: '2026-11-21', amountPaid: 38 });
    expect(read.ai).toBeTruthy();
    expect(weakRead(read)).toBe(false); // asked once only
    const r2: Record<string, any> = { text: 'x', data: {}, receipt: { supplier: {} } };
    mergeAiRead(r2, { supplier: 'GitHub, Inc.', total: 4 } as never, ['HRP AI LLP']);
    expect(r2.receipt.supplier.name).toBe('GitHub, Inc.');
    expect(r2.party.name).toBe('GitHub, Inc.');
  });
});
