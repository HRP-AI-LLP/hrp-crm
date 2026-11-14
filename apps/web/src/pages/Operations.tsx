import { hasAdmin, objectPerm } from '@synapse/shared';
import { Navigate } from 'react-router-dom';
import { InventoryPage } from '../components/ops/Inventory';
import { BillingPage } from '../components/ops/BillingPanels';
import { useApps, useMetaReady } from '../components/ops/OrderPanel';
import { Spinner } from '../components/ui';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/hooks';

export function InventoryRoute() {
  const { me } = useAuth();
  const { data: meta } = useMeta();
  const apps = useApps();
  const metaReady = useMetaReady();
  if (!meta || !me) return null;
  if (!apps.has('inventory')) return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  const canManage = hasAdmin(me.permissions, 'operations') || objectPerm(me.permissions, 'product').update === 'all';
  return <InventoryPage canManage={canManage} />;
}

export function BillingRoute() {
  const { me } = useAuth();
  const apps = useApps();
  const metaReady = useMetaReady();
  const { data: meta } = useMeta();
  if (!meta || !me) return null;
  if (!apps.has('billing')) return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  return <BillingPage isAccounts={hasAdmin(me.permissions, 'billing')} />;
}
