/**
 * JSON that Postgres jsonb accepts: text read from PDFs and mails can carry NUL characters and broken
 * surrogate halves, which jsonb refuses ("unsupported Unicode escape sequence"). They are dropped.
 */
const BAD = /\u0000|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

export const cleanText = (s: string) => s.replace(BAD, '');

export function jsonSafe(value: unknown): string {
  return JSON.stringify(value, (_k, v) => (typeof v === 'string' ? cleanText(v) : v));
}
