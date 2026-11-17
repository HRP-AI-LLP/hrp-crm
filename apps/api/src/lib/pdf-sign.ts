/**
 * PDF digital signatures (PAdES-style, adbe.pkcs7.detached) that Adobe Reader and other PDF readers
 * check: a signature field whose /Contents holds a CMS SignedData over the file's bytes except
 * /Contents itself (/ByteRange).
 *
 *   readPfx        a .pfx / .p12 → the private key and certificate chain (and the certificate's details)
 *   preparePdf     adds the signature field (visible text stamp optional) with a placeholder; returns
 *                  the bytes to sign and where the signature goes
 *   signPdf        prepare + CMS with a .pfx key
 *   embedCms       puts a CMS made elsewhere (a USB token through the local signer) into the placeholder
 *   verifyPdf      checks a signed PDF: the digest of the signed bytes, the signature by the
 *                  certificate's key, and returns the certificate
 */
import forge from 'node-forge';
import { PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, rgb, StandardFonts } from 'pdf-lib';

const SIG_LEN = 16384; // bytes reserved for the CMS (hex-encoded twice as long)

export interface CertInfo {
  subjectCn: string;
  subject: string;
  issuer: string;
  serial: string;
  thumbprint: string;
  validFrom: Date;
  validTo: Date;
}

const dn = (attrs: forge.pki.CertificateField[]) => attrs.map((a) => `${a.shortName ?? a.name}=${a.value}`).join(', ');

export function certInfo(cert: forge.pki.Certificate): CertInfo {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes();
  const md = forge.md.sha1.create();
  md.update(der);
  return {
    subjectCn: String(cert.subject.getField('CN')?.value ?? dn(cert.subject.attributes)),
    subject: dn(cert.subject.attributes),
    issuer: dn(cert.issuer.attributes),
    serial: cert.serialNumber,
    thumbprint: md.digest().toHex(),
    validFrom: cert.validity.notBefore,
    validTo: cert.validity.notAfter,
  };
}

export function certFromPem(pem: string) {
  return forge.pki.certificateFromPem(pem);
}

/** A .pfx (bytes) and its password → key, signing certificate and the rest of the chain. */
export function readPfx(pfx: Uint8Array, password: string) {
  let p12: forge.pkcs12.Pkcs12Pfx;
  try {
    const asn1 = forge.asn1.fromDer(bin(pfx));
    p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, password);
  } catch {
    throw new Error('This .pfx could not be opened: check the password');
  }
  const oids = forge.pki.oids as Record<string, string>;
  const bagsOf = (type: string) => (p12.getBags({ bagType: type }) as Record<string, forge.pkcs12.Bag[] | undefined>)[type] ?? [];
  const keyBags = [...bagsOf(oids.pkcs8ShroudedKeyBag!), ...bagsOf(oids.keyBag!)];
  const key = keyBags[0]?.key as forge.pki.rsa.PrivateKey | undefined;
  if (!key) throw new Error('The .pfx has no private key (export it with the key)');
  const certs = bagsOf(oids.certBag!).map((b) => b.cert).filter((c): c is forge.pki.Certificate => !!c);
  // the signing certificate is the one whose public key matches the private key
  const mine = certs.find((c) => {
    const pk = c.publicKey as forge.pki.rsa.PublicKey;
    return pk.n && pk.n.equals(key.n);
  });
  if (!mine) throw new Error('No certificate in the .pfx matches its private key');
  return { key, cert: mine, chain: certs.filter((c) => c !== mine) };
}

export interface Stamp {
  text: string[];
  /** last page by default */
  page?: number;
}

/** Adds the signature dictionary, field and (optionally) a visible text stamp; leaves room for the CMS. */
export async function preparePdf(pdf: Uint8Array, meta: { name: string; reason: string; location?: string; contact?: string; stamp?: Stamp | null }) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const pages = doc.getPages();
  const page = pages[meta.stamp?.page ?? pages.length - 1]!;
  let rect = [0, 0, 0, 0];
  if (meta.stamp) {
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const size = 7.5;
    const w = Math.max(...meta.stamp.text.map((t) => font.widthOfTextAtSize(t, size))) + 12;
    const h = meta.stamp.text.length * (size + 2.5) + 8;
    const x = page.getWidth() - w - 24;
    const y = 24;
    page.drawRectangle({ x, y, width: w, height: h, borderColor: rgb(0.03, 0.33, 0.57), borderWidth: 0.8, color: rgb(0.96, 0.98, 1) });
    meta.stamp.text.forEach((t, i) => page.drawText(t, { x: x + 6, y: y + h - 6 - (i + 1) * (size + 2.5) + 2.5, size, font, color: rgb(0.06, 0.09, 0.16) }));
    rect = [x, y, x + w, y + h];
  }
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const pdfDate = `D:${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const sigDict = doc.context.obj({
    Type: 'Sig',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'adbe.pkcs7.detached',
    ByteRange: [PDFNumber.of(0), PDFName.of('**********'), PDFName.of('**********'), PDFName.of('**********')],
    Contents: PDFHexString.of('0'.repeat(SIG_LEN * 2)),
    Reason: PDFString.of(meta.reason),
    Name: PDFString.of(meta.name),
    M: PDFString.of(pdfDate),
    ...(meta.location ? { Location: PDFString.of(meta.location) } : {}),
    ...(meta.contact ? { ContactInfo: PDFString.of(meta.contact) } : {}),
  });
  const sigRef = doc.context.register(sigDict);
  const widget = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Widget',
    FT: 'Sig',
    Rect: rect,
    V: sigRef,
    T: PDFString.of(`Signature${Date.now()}`),
    F: 4,
    P: page.ref,
  });
  const widgetRef = doc.context.register(widget);
  page.node.set(PDFName.of('Annots'), doc.context.obj([...(page.node.Annots()?.asArray() ?? []), widgetRef]));
  const acro = doc.catalog.getOrCreateAcroForm();
  acro.dict.set(PDFName.of('SigFlags'), PDFNumber.of(3));
  acro.addField(widgetRef);
  const saved = await doc.save({ useObjectStreams: false, addDefaultPage: false });
  return locate(saved);
}

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

/** Finds the placeholders, writes the real /ByteRange and returns what must be signed. */
function locate(bytes: Uint8Array) {
  const text = dec.decode(bytes);
  const start = text.indexOf(`<${'0'.repeat(256)}`);
  const end = start >= 0 ? text.indexOf('>', start) + 1 : -1;
  const brAt = text.lastIndexOf('/ByteRange', start);
  const brEnd = text.indexOf(']', brAt) + 1;
  if (start < 0 || end <= start || brAt < 0) throw new Error('Could not place the signature in the PDF');
  const range = [0, start, end, bytes.length - end];
  const br = `/ByteRange [${range.join(' ')}]`;
  const original = text.slice(brAt, brEnd);
  if (br.length > original.length) throw new Error('The PDF is too large to sign');
  const out = new Uint8Array(bytes);
  out.set(enc.encode(br.padEnd(original.length, ' ')), brAt);
  const signed = new Uint8Array(range[1]! + range[3]!);
  signed.set(out.subarray(0, range[1]), 0);
  signed.set(out.subarray(range[2]!, range[2]! + range[3]!), range[1]!);
  return { pdf: out, toSign: signed, contentsAt: start, contentsEnd: end };
}

/** Puts a DER-encoded CMS into the prepared PDF. */
export function embedCms(prepared: { pdf: Uint8Array; contentsAt: number; contentsEnd: number }, cmsDer: Uint8Array) {
  const hex = Array.from(cmsDer, (b) => b.toString(16).padStart(2, '0')).join('');
  const room = prepared.contentsEnd - prepared.contentsAt - 2;
  if (hex.length > room) throw new Error('The signature is larger than the space reserved for it');
  const out = new Uint8Array(prepared.pdf);
  out.set(enc.encode(hex.padEnd(room, '0')), prepared.contentsAt + 1);
  return out;
}

export async function sha256Bytes(b: Uint8Array) {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b)), (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Bytes as a binary string, in chunks (forge's own encoder overflows the stack on a multi-MB PDF). */
export function bin(u: Uint8Array) {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000) as unknown as number[]);
  return s;
}

/** Anything that signs like an RSA key: forge hands it the SHA-256 of the signed attributes. */
type RsaSigner = { sign: (md: forge.md.MessageDigest, scheme?: string) => string };

function cmsWith(data: Uint8Array, key: RsaSigner, cert: forge.pki.Certificate, chain: forge.pki.Certificate[], signingTime: Date) {
  const p7 = forge.pkcs7.createSignedData();
  p7.content = forge.util.createBuffer(bin(data));
  p7.addCertificate(cert);
  for (const c of chain) p7.addCertificate(c);
  p7.addSigner({
    key: key as unknown as forge.pki.rsa.PrivateKey,
    certificate: cert,
    digestAlgorithm: forge.pki.oids.sha256!,
    authenticatedAttributes: [
      { type: forge.pki.oids.contentType!, value: forge.pki.oids.data! },
      { type: forge.pki.oids.messageDigest! },
      { type: forge.pki.oids.signingTime!, value: signingTime as unknown as string },
    ],
  });
  p7.sign({ detached: true });
  return forge.util.binary.raw.decode(forge.asn1.toDer(p7.toAsn1()).getBytes());
}

/** CMS SignedData (detached, SHA-256, signing time) over `data` with a key and certificate. */
export function cmsSign(data: Uint8Array, key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate, chain: forge.pki.Certificate[] = [], signingTime = new Date()) {
  return cmsWith(data, key as unknown as RsaSigner, cert, chain, signingTime);
}

/**
 * Signing with a key held elsewhere (a USB token), in two steps. First the SHA-256 that the key must sign
 * (of the CMS signed attributes, which fix the PDF's digest and the signing time) …
 */
export function cmsDigestToSign(data: Uint8Array, cert: forge.pki.Certificate, signingTime: Date): Uint8Array {
  let digest = '';
  cmsWith(data, { sign: (md) => ((digest = md.digest().getBytes()), '\0') }, cert, [], signingTime);
  return forge.util.binary.raw.decode(digest);
}

/** … then the CMS around the RSA PKCS#1 v1.5 signature the key made over that digest (same time). */
export function cmsWithSignature(data: Uint8Array, cert: forge.pki.Certificate, signingTime: Date, signature: Uint8Array) {
  return cmsWith(data, { sign: () => bin(signature) }, cert, [], signingTime);
}

/** The PKCS#1 DigestInfo for a SHA-256 digest: what a token's raw RSA (CKM_RSA_PKCS) signs. */
export function sha256DigestInfo(digest: Uint8Array) {
  const prefix = [0x30, 0x31, 0x30, 0x0d, 0x06, 0x09, 0x60, 0x86, 0x48, 0x01, 0x65, 0x03, 0x04, 0x02, 0x01, 0x05, 0x00, 0x04, 0x20];
  return new Uint8Array([...prefix, ...digest]);
}

/** The placeholders of a PDF from preparePdf() (sent away and back): where the signature goes and what it covers. */
export function placeholders(prepared: Uint8Array) {
  return locate(prepared);
}

export async function signPdf(pdf: Uint8Array, signer: { key: forge.pki.rsa.PrivateKey; cert: forge.pki.Certificate; chain: forge.pki.Certificate[] }, meta: Parameters<typeof preparePdf>[1]) {
  const prepared = await preparePdf(pdf, meta);
  const cms = cmsSign(prepared.toSign, signer.key, signer.cert, signer.chain);
  return embedCms(prepared, cms);
}

/**
 * Checks the last signature in a PDF: the bytes it covers hash to the signed message digest, the
 * signature over the signed attributes verifies with the certificate's key, and it covers the whole
 * file. Returns the signing certificate.
 */
export function verifyPdf(bytes: Uint8Array): { ok: boolean; reason?: string; cert?: CertInfo; coversWholeFile?: boolean } {
  const text = dec.decode(bytes);
  const brAt = text.lastIndexOf('/ByteRange');
  if (brAt < 0) return { ok: false, reason: 'The PDF is not signed' };
  const m = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text.slice(brAt, brAt + 120));
  if (!m) return { ok: false, reason: 'The signature has no byte range' };
  const [a, b, c, d] = m.slice(1).map(Number) as [number, number, number, number];
  const hex = text.slice(a + b + 1, c - 1).replace(/0+$/, '');
  if (!hex) return { ok: false, reason: 'The signature is empty' };
  try {
    const der = forge.util.hexToBytes(hex.length % 2 ? `${hex}0` : hex);
    const asn1 = forge.asn1.fromDer(der, { strict: false } as never);
    const p7 = forge.pkcs7.messageFromAsn1(asn1) as forge.pkcs7.PkcsSignedData & { rawCapture: any };
    const raw = p7.rawCapture;
    const cert = p7.certificates[0];
    if (!cert) return { ok: false, reason: 'The signature carries no certificate' };
    // the signer's certificate: the one whose serial the signer info names
    const serialHex = forge.util.bytesToHex(raw.serial ?? '');
    const signerCert = p7.certificates.find((x) => x.serialNumber.replace(/^0+/, '') === serialHex.replace(/^0+/, '')) ?? cert;
    const covered = new Uint8Array(b + d);
    covered.set(bytes.subarray(a, a + b), 0);
    covered.set(bytes.subarray(c, c + d), b);
    const digestOid = forge.asn1.derToOid(raw.digestAlgorithm);
    const mdFor = (oid: string) => (oid === forge.pki.oids.sha512 ? forge.md.sha512.create() : oid === forge.pki.oids.sha384 ? forge.md.sha384.create() : oid === forge.pki.oids.sha1 ? forge.md.sha1.create() : forge.md.sha256.create());
    const md = mdFor(digestOid);
    md.update(bin(covered));
    const contentDigest = md.digest().getBytes();
    const attrs: any[] = raw.authenticatedAttributes ?? [];
    let signedDigest: string | null = null;
    for (const at of attrs) {
      const oid = forge.asn1.derToOid(at.value[0].value);
      if (oid === forge.pki.oids.messageDigest) signedDigest = at.value[1].value[0].value;
    }
    if (signedDigest == null) return { ok: false, reason: 'The signature has no message digest' };
    if (signedDigest !== contentDigest) return { ok: false, reason: 'The document changed after it was signed', cert: certInfo(signerCert) };
    // the signed attributes are signed as a SET
    const set = forge.asn1.create(forge.asn1.Class.UNIVERSAL, forge.asn1.Type.SET, true, attrs);
    const amd = mdFor(digestOid);
    amd.update(forge.asn1.toDer(set).getBytes());
    const ok = (signerCert.publicKey as forge.pki.rsa.PublicKey).verify(amd.digest().getBytes(), raw.signature);
    return ok ? { ok: true, cert: certInfo(signerCert), coversWholeFile: c + d === bytes.length } : { ok: false, reason: 'The signature does not match the certificate', cert: certInfo(signerCert) };
  } catch (e) {
    return { ok: false, reason: `The signature could not be read (${(e as Error).message})` };
  }
}

/** A self-signed certificate and key for tests and demos (never for real documents). */
export function testIdentity(cn = 'Test Signer') {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01ab';
  cert.validity.notBefore = new Date(Date.now() - 86_400_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  const attrs = [{ name: 'commonName', value: cn }, { name: 'countryName', value: 'IN' }, { name: 'organizationName', value: 'HRP AI LLP' }];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { key: keys.privateKey, cert };
}

export function toPfx(key: forge.pki.rsa.PrivateKey, cert: forge.pki.Certificate, password: string) {
  const p12 = forge.pkcs12.toPkcs12Asn1(key, [cert], password, { algorithm: '3des' });
  return forge.util.binary.raw.decode(forge.asn1.toDer(p12).getBytes());
}
