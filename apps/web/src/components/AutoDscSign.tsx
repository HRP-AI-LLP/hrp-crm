/**
 * Automatic DSC signing with a USB token, while a SanchalanOS tab is open on the laptop that has the
 * token plugged in and the local signer running.
 *
 * The cloud can't reach the token, so this runs in the browser: every minute it asks for issued
 * invoices that aren't signed yet and signs each one with the token, using the PIN saved in settings —
 * no human in the loop. Invoices generated overnight get signed the next time a tab is open here.
 *
 * It does nothing unless the auto-sign certificate is a token certificate with a saved PIN.
 */
import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useAuth } from '../lib/auth';
import { signWithToken } from '../lib/dsc';
import { get } from '../lib/api';

type Json = Record<string, any>;
const EVERY_MS = 60_000;

export function AutoDscSign() {
  const { me } = useAuth();
  const enabled = !!me;
  const settings = useQuery({ queryKey: ['billing-settings'], queryFn: () => get<Json>('/api/v1/billing/settings'), enabled, staleTime: 60_000 });
  const dsc = useQuery({ queryKey: ['org-dsc'], queryFn: () => get<Json>('/api/v1/organisation/dsc'), enabled, staleTime: 60_000 });

  const certId = settings.data?.autoDscCertId as string | undefined;
  const certs = (dsc.data?.certificates ?? []) as Json[];
  const cert = certId ? certs.find((c) => c.id === certId) : undefined;
  const active = !!(me && cert && cert.kind === 'token' && cert.autoPin && !cert.expired);

  const pinRef = useRef<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    if (!active || !me) return;
    const paired = (dsc.data?.signers ?? []) as { id: string }[];
    let stop = false;

    const tick = async () => {
      if (stop || busy.current) return;
      busy.current = true;
      try {
        const { invoices } = await get<{ invoices: { id: string; number: string | null }[] }>('/api/v1/organisation/dsc-pending-invoices');
        if (!invoices.length) return;
        // the signer must be reachable and the PIN known before we try
        if (!pinRef.current) pinRef.current = (await get<{ pin: string }>(`/api/v1/organisation/dsc/${certId}/auto-pin`)).pin;
        for (const inv of invoices) {
          if (stop) break;
          try {
            await signWithToken('invoice', inv.id, certId!, pinRef.current!, me, paired);
          } catch {
            // token unplugged, signer down, or wrong PIN — stop this round, retry next tick
            break;
          }
        }
      } catch {
        /* offline or not permitted; try again next tick */
      } finally {
        busy.current = false;
      }
    };

    void tick();
    const h = window.setInterval(tick, EVERY_MS);
    return () => {
      stop = true;
      window.clearInterval(h);
    };
  }, [active, me, certId, dsc.data]);

  // clear the cached PIN if the certificate changes
  useEffect(() => {
    pinRef.current = null;
  }, [certId]);

  return null;
}
