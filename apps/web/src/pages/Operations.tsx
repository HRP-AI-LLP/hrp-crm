import { hasAdmin, objectPerm } from '@synapse/shared';
import { Navigate } from 'react-router-dom';
import { InventoryPage } from '../components/ops/Inventory';
import { useApps } from '../components/ops/OrderPanel';
import { useAuth } from '../lib/auth';
import { useMeta } from '../lib/hooks';

export function InventoryRoute() {
  const { me } = useAuth();
  const { data: meta } = useMeta();
  const apps = useApps();
  if (!meta || !me) return null;
  if (!apps.has('inventory')) return <Navigate to="/" replace />;
  const canManage = hasAdmin(me.permissions, 'operations') || objectPerm(me.permissions, 'product').update === 'all';
  return <InventoryPage canManage={canManage} />;
}
