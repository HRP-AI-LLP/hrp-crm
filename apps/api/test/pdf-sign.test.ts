import { describe, expect, it } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { certInfo, readPfx, signPdf, testIdentity, toPfx, verifyPdf } from '../src/lib/pdf-sign';

async function samplePdf() {
  const d = await PDFDocument.create();
  const p = d.addPage([595, 842]);
  p.drawText('TAX INVOICE INV-2026000010  Total 1,200.00', { x: 50, y: 780, size: 12, font: await d.embedFont(StandardFonts.Helvetica) });
  return d.save();
}

describe('PDF digital signatures', () => {
  const id = testIdentity('Harsha Rani');
  const pfx = toPfx(id.key, id.cert, 'secret');

  it('reads a .pfx and refuses a wrong password', () => {
    const r = readPfx(pfx, 'secret');
    expect(certInfo(r.cert)).toMatchObject({ subjectCn: 'Harsha Rani' });
    expect(() => readPfx(pfx, 'nope')).toThrow(/password/);
  });

  it('signs a PDF that verifies, and notices any change', async () => {
    const pdf = await samplePdf();
    const signed = await signPdf(pdf, readPfx(pfx, 'secret'), { name: 'Harsha Rani', reason: 'Invoice INV-2026000010', location: 'Noida', stamp: { text: ['Digitally signed by Harsha Rani', 'Date: 17 Nov 2026'] } });
    const v = verifyPdf(signed);
    expect(v).toMatchObject({ ok: true, coversWholeFile: true, cert: { subjectCn: 'Harsha Rani' } });
    // the result still opens as a PDF
    expect((await PDFDocument.load(signed)).getPageCount()).toBe(1);
    const tampered = new Uint8Array(signed);
    // change one byte of the page (before the signature)
    const at = new TextDecoder('latin1').decode(signed).indexOf('/MediaBox');
    tampered[at + 12] = tampered[at + 12] === 0x35 ? 0x36 : 0x35;
    expect(verifyPdf(tampered).ok).toBe(false);
  });

  it('signs a multi-megabyte PDF (scanned pages, letterheads)', async () => {
    const d = await PDFDocument.load(await samplePdf());
    // a 3 MB stream that does not compress: random bytes as an attachment
    const noise = new Uint8Array(3_000_000);
    for (let i = 0; i < noise.length; i += 65536) crypto.getRandomValues(noise.subarray(i, i + 65536));
    await d.attach(noise, 'scan.bin', { mimeType: 'application/octet-stream' });
    const big = await d.save({ useObjectStreams: false });
    expect(big.length).toBeGreaterThan(2_900_000);
    const signed = await signPdf(big, readPfx(pfx, 'secret'), { name: 'Harsha Rani', reason: 'Invoice', location: 'Noida', stamp: { text: ['Digitally signed by Harsha Rani'] } });
    expect(verifyPdf(signed)).toMatchObject({ ok: true, coversWholeFile: true });
  }, 60_000);
});
