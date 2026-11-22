/** The assistant's route catalogue must match the routes (run `pnpm --filter @synapse/api catalogue` after changing them). */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain ESM script
import { build } from '../scripts/assistant-catalogue.mjs';

describe('assistant catalogue', () => {
  it('is up to date', () => {
    const cur = readFileSync(join(__dirname, '../src/services/assistant-catalogue.generated.ts'), 'utf8');
    expect(cur === build(), 'assistant-catalogue.generated.ts is stale: run pnpm --filter @synapse/api catalogue').toBe(true);
  });
});
