// Loads KEY=value lines from the repo-root .env (git-ignored) into process.env without
// overriding anything already set in the terminal. Values are never printed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** @param {string} root @returns {string[]} the names that were loaded */
export function loadDotEnv(root) {
  const loaded = [];
  for (const name of ['.env', '.env.local']) {
    const file = join(root, name);
    if (!existsSync(file)) continue;
    for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      const name = /** @type {string} */ (m[1]);
      let v = m[2] ?? '';
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      else v = v.replace(/\s+#.*$/, '');
      if (process.env[name] === undefined && v !== '') {
        process.env[name] = v;
        loaded.push(name);
      }
    }
  }
  return loaded;
}

/** The WhiteBooks GSP settings passed through to apps/api/.dev.vars. */
export const WHITEBOOKS_KEYS = [
  'WHITEBOOKS_ENV',
  'WHITEBOOKS_BASE_URL',
  'WHITEBOOKS_EMAIL',
  'WHITEBOOKS_CLIENT_ID',
  'WHITEBOOKS_CLIENT_SECRET',
  'WHITEBOOKS_EINVOICE_CLIENT_ID',
  'WHITEBOOKS_EINVOICE_CLIENT_SECRET',
  'WHITEBOOKS_EWAYBILL_CLIENT_ID',
  'WHITEBOOKS_EWAYBILL_CLIENT_SECRET',
];
