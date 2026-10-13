/**
 * Built-in apps: groups of standard objects and screens a workspace switches on in
 * Settings → Apps. Switching an app on creates its objects (module_key 'app.<key>'), seeds its
 * defaults and roles; switching it off hides them without deleting data.
 */
export interface AppObject {
  key: string;
  label: string;
  plural: string;
  icon: string;
}

export interface AppDefinition {
  key: string;
  name: string;
  description: string;
  objects: AppObject[];
  /** apps that must be on first */
  requires: string[];
  /** roles created when the app is switched on (key → name, description, permissions) */
  roles?: { key: string; name: string; description: string; permissions: Record<string, unknown> }[];
}

const all = { read: 'all', create: true, update: 'all', delete: 'none' } as const;
const readOnly = { read: 'all', create: false, update: 'none', delete: 'none' } as const;
const none = { read: 'none', create: false, update: 'none', delete: 'none' } as const;

export const APPS: Record<string, AppDefinition> = {
  orders: {
    key: 'orders',
    name: 'Sales orders',
    description: 'Turn accepted quotes into orders, track status from confirmation to completion, and plan payment milestones (advance, before dispatch, after installation).',
    objects: [{ key: 'sales_order', label: 'Sales Order', plural: 'Sales Orders', icon: 'shopping-cart' }],
    requires: [],
  },
  inventory: {
    key: 'inventory',
    name: 'Inventory',
    description: 'Warehouses, stock in / out / adjust / transfer, reservations against orders, product categories and variants, and reorder alerts.',
    objects: [],
    requires: [],
    roles: [
      {
        key: 'inventory_manager',
        name: 'Inventory Manager',
        description: 'Products, stock, warehouses and goods receipts',
        permissions: { objects: { '*': readOnly, product: all, purchase_order: all, vendor: all, sales_order: readOnly }, admin: ['operations'] },
      },
    ],
  },
  purchasing: {
    key: 'purchasing',
    name: 'Vendors & purchasing',
    description: 'Vendor master with documents and performance, purchase orders with approval, and goods receipts that bring stock in.',
    objects: [
      { key: 'vendor', label: 'Vendor', plural: 'Vendors', icon: 'truck' },
      { key: 'purchase_order', label: 'Purchase Order', plural: 'Purchase Orders', icon: 'clipboard' },
    ],
    requires: [],
    roles: [
      {
        key: 'operations',
        name: 'Operations',
        description: 'Orders, purchasing, deliveries and installations',
        permissions: { objects: { '*': readOnly, sales_order: all, purchase_order: all, vendor: all, product: all, lead: none }, admin: ['operations'] },
      },
    ],
  },
};

export const APP_KEYS = Object.keys(APPS);
export const appModuleKey = (k: string) => `app.${k}`;

/** Objects that belong to an app (so screens can tell whether it is switched on). */
export function appOfObject(objectKey: string): string | null {
  for (const a of Object.values(APPS)) if (a.objects.some((o) => o.key === objectKey)) return a.key;
  return null;
}
