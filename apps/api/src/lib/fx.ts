/** Exchange rates for foreign-currency documents. */
import type { Tx } from './db';

/** The reference rate of a day (ECB, via frankfurter.dev): null when it cannot be had. */
export async function fxRate(currency: string, date: string | null, f: typeof fetch = fetch): Promise<{ rate: number; date: string } | null> {
  if (currency === 'INR') return { rate: 1, date: date ?? '' };
  try {
    const res = await f(`https://api.frankfurter.dev/v1/${date ?? 'latest'}?base=${encodeURIComponent(currency)}&symbols=INR`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const j = (await res.json()) as { rates?: { INR?: number }; date?: string };
    return j.rates?.INR ? { rate: j.rates.INR, date: j.date ?? date ?? '' } : null;
  } catch {
    return null;
  }
}


/**
 * The rate for a document: the workspace's own rate for that day (Books → exchange rates), else the
 * reference rate fetched and kept there, else the workspace's latest earlier rate.
 */
export async function rateForDoc(tx: Tx, tenantId: string, currency: string, date: string, f: typeof fetch = fetch): Promise<{ rate: number; date: string; source: 'own' | 'ecb' | 'earlier' } | null> {
  if (currency === 'INR') return { rate: 1, date, source: 'own' };
  const own = await tx.one<{ rate: number; d: string }>(`select rate::float8 as rate, rate_date::text as d from exchange_rates where tenant_id = $1 and currency = $2 and rate_date = $3::date`, [tenantId, currency, date]);
  if (own) return { rate: own.rate, date: own.d, source: 'own' };
  const fx = await fxRate(currency, date, f);
  if (fx) {
    await tx.query(`insert into exchange_rates (tenant_id, currency, rate_date, rate) values ($1,$2,$3,$4) on conflict (tenant_id, currency, rate_date) do nothing`, [tenantId, currency, date, fx.rate]);
    return { rate: fx.rate, date: fx.date || date, source: 'ecb' };
  }
  const before = await tx.one<{ rate: number; d: string }>(`select rate::float8 as rate, rate_date::text as d from exchange_rates where tenant_id = $1 and currency = $2 and rate_date <= $3::date order by rate_date desc limit 1`, [tenantId, currency, date]);
  return before ? { rate: before.rate, date: before.d, source: 'earlier' } : null;
}
