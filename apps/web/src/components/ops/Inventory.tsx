import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, post, put, del } from '../../lib/api';
import { dateTime, money2 } from '../../lib/format';
import { useMeta } from '../../lib/hooks';
import { Empty, Modal, Spinner, useToast } from '../ui';

type Json = Record<string, any>;
const MOVE_LABEL: Record<string, string> = { in: 'Stock in', out: 'Stock out', adjust: 'Adjustment', transfer_in: 'Transfer in', transfer_out: 'Transfer out', reserve: 'Reserved', release: 'Released' };
const qty = (n: number) => Number(n).toLocaleString('en-IN', { maximumFractionDigits: 3 });

export function useWarehouses() {
  return useQuery({ queryKey: ['warehouses'], queryFn: () => get<{ items: Json[] }>('/api/v1/warehouses'), staleTime: 60_000 });
}

/** Stock in / out / adjust / transfer for one product (or a product picked in the modal). */
export function StockMoveModal({ productId, productName, onClose, onDone }: { productId?: string; productName?: string; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const wh = useWarehouses();
  const products = useQuery({ queryKey: ['product-options'], queryFn: () => get<{ items: Json[] }>('/api/v1/records/product?limit=200&sort=name&dir=asc'), enabled: !productId });
  const active = (wh.data?.items ?? []).filter((w) => w.is_active);
  const [f, setF] = useState({ type: 'in', productId: productId ?? '', warehouseId: '', to: '', quantity: '', reason: '', unitCost: '' });
  const whId = f.warehouseId || active[0]?.id || '';
  const save = async () => {
    try {
      if (f.type === 'transfer') await post('/api/v1/inventory/transfers', { productId: f.productId, from: whId, to: f.to, quantity: Number(f.quantity), reason: f.reason || null });
      else
        await post('/api/v1/inventory/movements', {
          type: f.type,
          productId: f.productId,
          warehouseId: whId,
          quantity: Number(f.quantity),
          reason: f.reason || null,
          unitCost: f.unitCost ? Number(f.unitCost) : null,
        });
      toast('Stock updated');
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  return (
    <Modal
      title={productName ? `Update stock — ${productName}` : 'Update stock'}
      onClose={onClose}
      footer={
        <button className="btn primary" disabled={!f.productId || !whId || !Number(f.quantity) || (f.type === 'transfer' && !f.to) || (f.type === 'adjust' && !f.reason.trim())} onClick={save}>
          Save
        </button>
      }
    >
      <div className="modal-body">
        <label className="field wide">
          What happened
          <select value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>
            <option value="in">Stock in (purchase, return, opening stock)</option>
            <option value="out">Stock out (sold, used, damaged)</option>
            <option value="adjust">Adjustment after a stock count (+/−)</option>
            <option value="transfer">Transfer between warehouses</option>
          </select>
        </label>
        {!productId && (
          <label className="field wide">
            Product
            <select value={f.productId} onChange={(e) => setF({ ...f, productId: e.target.value })}>
              <option value="">Choose…</option>
              {products.data?.items
                .filter((p) => p.product_type !== 'service')
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.sku ? ` (${p.sku})` : ''}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          {f.type === 'transfer' ? 'From' : 'Warehouse'}
          <select value={whId} onChange={(e) => setF({ ...f, warehouseId: e.target.value })}>
            {active.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </label>
        {f.type === 'transfer' && (
          <label className="field">
            To
            <select value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })}>
              <option value="">Choose…</option>
              {active
                .filter((w) => w.id !== whId)
                .map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label className="field">
          Quantity{f.type === 'adjust' ? ' (use − to reduce)' : ''}
          <input inputMode="decimal" value={f.quantity} onChange={(e) => setF({ ...f, quantity: e.target.value })} autoFocus />
        </label>
        {f.type === 'in' && (
          <label className="field">
            Unit cost (optional)
            <input inputMode="decimal" value={f.unitCost} onChange={(e) => setF({ ...f, unitCost: e.target.value })} />
          </label>
        )}
        <label className="field wide">
          {f.type === 'adjust' ? 'Reason (required)' : 'Note'}
          <input value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder={f.type === 'adjust' ? 'Monthly stock count' : ''} />
        </label>
      </div>
    </Modal>
  );
}

/** Product record: stock per warehouse, recent movements and variants. */
export function ProductStockPanel({ productId, productName, canMove, isVariant }: { productId: string; productName: string; canMove: boolean; isVariant: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data } = useQuery({ queryKey: ['product-stock', productId], queryFn: () => get<Json>(`/api/v1/inventory/products/${productId}`) });
  const variants = useQuery({ queryKey: ['variants', productId], queryFn: () => get<{ items: Json[] }>(`/api/v1/products/${productId}/variants`), enabled: !isVariant });
  const [moving, setMoving] = useState(false);
  const [gen, setGen] = useState<{ name: string; values: string }[] | null>(null);
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['product-stock', productId] });
    qc.invalidateQueries({ queryKey: ['record', 'product', productId] });
    qc.invalidateQueries({ queryKey: ['inventory'] });
  };
  return (
    <section className="panel" style={{ marginBottom: 20 }}>
      <div className="panel-head">
        <h2>Stock</h2>
        <div className="row">
          {!isVariant && canMove && (
            <button className="btn sm" onClick={() => setGen([{ name: 'Finish', values: '' }, { name: 'Size', values: '' }])}>
              Create variants
            </button>
          )}
          {canMove && (
            <button className="btn sm primary" onClick={() => setMoving(true)}>
              Update stock
            </button>
          )}
        </div>
      </div>
      <div className="panel-body stack">
        {!data ? (
          <Spinner />
        ) : (
          <table className="data">
            <thead>
              <tr>
                <th>Warehouse</th>
                <th className="num">On hand</th>
                <th className="num">Reserved</th>
                <th className="num">Available</th>
              </tr>
            </thead>
            <tbody>
              {data.levels.map((l: Json) => (
                <tr key={l.warehouse_id}>
                  <td>{l.name}</td>
                  <td className="num">{qty(l.on_hand)}</td>
                  <td className="num">{qty(l.reserved)}</td>
                  <td className="num">
                    <b style={{ color: l.available < 0 ? 'var(--bad)' : undefined }}>{qty(l.available)}</b>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {!isVariant && !!variants.data?.items.length && (
          <>
            <h3>Variants</h3>
            <table className="data">
              <tbody>
                {variants.data.items.map((v) => (
                  <tr key={v.id}>
                    <td>
                      <Link to={`/o/product/${v.id}`}>{v.variant_options}</Link>
                      <div className="muted small">{v.sku ?? ''}</div>
                    </td>
                    <td className="num">{money2(v.list_price)}</td>
                    <td className="num">{qty(v.available)} available</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {!!data?.movements.length && (
          <details>
            <summary className="small">Recent movements ({data.movements.length})</summary>
            <MovementsTable rows={data.movements} hideProduct />
          </details>
        )}
      </div>
      {moving && <StockMoveModal productId={productId} productName={productName} onClose={() => setMoving(false)} onDone={() => { setMoving(false); refresh(); }} />}
      {gen && (
        <Modal
          title="Create variants"
          onClose={() => setGen(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () => {
                try {
                  const attributes = gen.map((a) => ({ name: a.name.trim(), values: a.values.split(',').map((v) => v.trim()).filter(Boolean) })).filter((a) => a.name && a.values.length);
                  const r = await post<{ created: number; skipped: number }>(`/api/v1/products/${productId}/variants`, { attributes });
                  toast(`${r.created} variants created${r.skipped ? `, ${r.skipped} already existed` : ''}`);
                  setGen(null);
                  qc.invalidateQueries({ queryKey: ['variants', productId] });
                  qc.invalidateQueries({ queryKey: ['records', 'product'] });
                } catch (e) {
                  toast((e as Error).message, true);
                }
              }}
            >
              Create
            </button>
          }
        >
          <div className="modal-body" style={{ display: 'block' }}>
            <p className="muted small" style={{ marginTop: 0 }}>
              One product per combination, e.g. Finish: Teak, Walnut × Size: 2 seater, 3 seater → 4 variants. They copy this product's price, tax and stock settings.
            </p>
            {gen.map((a, i) => (
              <div key={i} className="filter-row" style={{ gridTemplateColumns: '140px 1fr 34px' }}>
                <input aria-label="Attribute" value={a.name} onChange={(e) => setGen(gen.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} placeholder="Attribute" />
                <input aria-label="Values" value={a.values} onChange={(e) => setGen(gen.map((x, j) => (j === i ? { ...x, values: e.target.value } : x)))} placeholder="Values, comma separated" />
                <button className="btn ghost sm" aria-label="Remove" onClick={() => setGen(gen.filter((_, j) => j !== i))}>
                  ✕
                </button>
              </div>
            ))}
            {gen.length < 3 && (
              <button className="btn sm" onClick={() => setGen([...gen, { name: '', values: '' }])}>
                Add attribute
              </button>
            )}
          </div>
        </Modal>
      )}
    </section>
  );
}

function MovementsTable({ rows, hideProduct }: { rows: Json[]; hideProduct?: boolean }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th>When</th>
            {!hideProduct && <th>Product</th>}
            <th>Movement</th>
            <th>Warehouse</th>
            <th className="num">Qty</th>
            <th className="num">On hand after</th>
            <th>Reference</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((m) => (
            <tr key={m.id}>
              <td className="small">
                {dateTime(m.created_at)}
                <div className="muted">{m.user_name ?? 'Automation'}</div>
              </td>
              {!hideProduct && <td>{m.product_name}</td>}
              <td>{MOVE_LABEL[m.movement_type] ?? m.movement_type}</td>
              <td>{m.warehouse_name}</td>
              <td className="num" style={{ color: m.qty_delta < 0 ? 'var(--bad)' : m.qty_delta > 0 ? 'var(--good)' : undefined }}>
                {m.qty_delta ? (m.qty_delta > 0 ? `+${qty(m.qty_delta)}` : qty(m.qty_delta)) : m.reserved_delta ? `${m.reserved_delta > 0 ? '+' : ''}${qty(m.reserved_delta)} res.` : '—'}
              </td>
              <td className="num">{qty(m.on_hand_after)}</td>
              <td className="small">
                {m.ref_object && m.ref_id && m.ref_object !== 'transfer' ? <Link to={`/o/${m.ref_object}/${m.ref_id}`}>{m.ref_label}</Link> : m.ref_label}
                {m.reason && <div className="muted">{m.reason}</div>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** /inventory — stock overview, movement ledger, warehouses and categories. */
export function InventoryPage({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<'stock' | 'moves' | 'warehouses' | 'categories'>('stock');
  const [q, setQ] = useState('');
  const [whF, setWhF] = useState('');
  const [low, setLow] = useState(false);
  const [moving, setMoving] = useState(false);
  const wh = useWarehouses();
  const stock = useQuery({
    queryKey: ['inventory', 'stock', q, whF, low],
    queryFn: () => get<{ items: Json[]; totals: Json }>(`/api/v1/inventory/stock?${new URLSearchParams({ ...(q ? { q } : {}), ...(whF ? { warehouse: whF } : {}), ...(low ? { low: '1' } : {}) })}`),
    enabled: tab === 'stock',
  });
  const moves = useQuery({ queryKey: ['inventory', 'moves'], queryFn: () => get<{ items: Json[] }>('/api/v1/inventory/movements'), enabled: tab === 'moves' });
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Inventory</h1>
          <p>Stock by warehouse, reservations for confirmed orders, and every movement.</p>
        </div>
        {canManage && (
          <button className="btn primary" onClick={() => setMoving(true)}>
            Update stock
          </button>
        )}
      </div>
      {stock.data && (
        <div className="kpis">
          <div className="panel kpi">
            <div className="l">Stock value (at cost)</div>
            <div className="v">{money2(stock.data.totals.stockValue)}</div>
          </div>
          <div className="panel kpi">
            <div className="l">Products tracked</div>
            <div className="v">{stock.data.totals.trackedProducts}</div>
          </div>
          <div className="panel kpi">
            <div className="l">At or below reorder level</div>
            <div className="v" style={{ color: stock.data.totals.lowStock ? 'var(--bad)' : undefined }}>
              {stock.data.totals.lowStock}
            </div>
          </div>
        </div>
      )}
      <section className="panel">
        <div className="tabs" role="tablist">
          {(
            [
              ['stock', 'Stock'],
              ['moves', 'Movements'],
              ['warehouses', 'Warehouses'],
              ['categories', 'Categories'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>
              {l}
            </button>
          ))}
        </div>
        {tab === 'stock' && (
          <div className="panel-body stack">
            <div className="row" style={{ flexWrap: 'wrap' }}>
              <input type="search" placeholder="Search name, SKU or barcode" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} aria-label="Search stock" />
              <select value={whF} onChange={(e) => setWhF(e.target.value)} style={{ width: 'auto' }} aria-label="Warehouse">
                <option value="">All warehouses</option>
                {wh.data?.items.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
              <label className="row small">
                <input type="checkbox" checked={low} onChange={(e) => setLow(e.target.checked)} /> Low stock only
              </label>
            </div>
            {!stock.data ? (
              <Spinner />
            ) : !stock.data.items.length ? (
              <Empty title="No stock yet">Tick “Track stock” on a product, then book opening stock with “Update stock”.</Empty>
            ) : (
              <div className="table-wrap">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num">On hand</th>
                      <th className="num">Reserved</th>
                      <th className="num">Available</th>
                      <th className="num">Reorder at</th>
                      <th className="num">Value</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stock.data.items.map((p) => {
                      const isLow = p.reorder_level !== null && p.available <= p.reorder_level;
                      return (
                        <tr key={p.id}>
                          <td>
                            <Link to={`/o/product/${p.id}`}>{p.name}</Link>
                            <div className="muted small">{[p.sku, p.variant_options].filter(Boolean).join(' · ')}</div>
                          </td>
                          <td className="num">{qty(p.on_hand)}</td>
                          <td className="num">{qty(p.reserved)}</td>
                          <td className="num">
                            <b style={{ color: isLow ? 'var(--bad)' : undefined }}>{qty(p.available)}</b>
                            {isLow && <span className="chip bad" style={{ marginLeft: 6 }}>low</span>}
                          </td>
                          <td className="num">{p.reorder_level === null ? '—' : qty(p.reorder_level)}</td>
                          <td className="num">{p.cost_price ? money2(p.on_hand * p.cost_price) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {tab === 'moves' && <div className="panel-body">{!moves.data ? <Spinner /> : moves.data.items.length ? <MovementsTable rows={moves.data.items} /> : <Empty title="No movements yet" />}</div>}
        {tab === 'warehouses' && <WarehousesTab canManage={canManage} />}
        {tab === 'categories' && <CategoriesTab canManage={canManage} />}
      </section>
      {moving && <StockMoveModal onClose={() => setMoving(false)} onDone={() => { setMoving(false); qc.invalidateQueries({ queryKey: ['inventory'] }); }} />}
    </>
  );
}

function WarehousesTab({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const wh = useWarehouses();
  const [edit, setEdit] = useState<Json | null>(null);
  const settings = useQuery({ queryKey: ['inventory-settings'], queryFn: () => get<{ allowNegative?: boolean }>('/api/v1/inventory/settings') });
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['warehouses'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
      return true;
    } catch (e) {
      toast((e as Error).message, true);
      return false;
    }
  };
  return (
    <div className="panel-body stack">
      {canManage && (
        <div className="spread">
          <label className="row small">
            <input
              type="checkbox"
              checked={!!settings.data?.allowNegative}
              onChange={async (e) => {
                await run(() => put('/api/v1/inventory/settings', { allowNegative: e.target.checked }), 'Saved');
                qc.invalidateQueries({ queryKey: ['inventory-settings'] });
              }}
            />
            Allow selling below zero stock (back-orders)
          </label>
          <button className="btn primary sm" onClick={() => setEdit({ code: '', name: '', address: '', state: '', isDefault: false })}>
            Add warehouse
          </button>
        </div>
      )}
      <table className="data">
        <tbody>
          {wh.data?.items.map((w) => (
            <tr key={w.id} className={w.is_active ? undefined : 'muted-row'}>
              <td>
                <b>{w.name}</b> <span className="muted small">{w.code}</span> {w.is_default && <span className="chip">default</span>}
                <div className="muted small">{[w.address, w.state].filter(Boolean).join(', ')}</div>
              </td>
              <td className="small">{w.products} products in stock</td>
              <td className="row" style={{ justifyContent: 'flex-end' }}>
                {canManage && !w.is_default && w.is_active && (
                  <button className="btn sm" onClick={() => run(() => patch(`/api/v1/warehouses/${w.id}`, { isDefault: true }), 'Default warehouse changed')}>
                    Make default
                  </button>
                )}
                {canManage && (
                  <button className="btn sm" onClick={() => run(() => patch(`/api/v1/warehouses/${w.id}`, { isActive: !w.is_active }), w.is_active ? 'Warehouse deactivated' : 'Warehouse activated')}>
                    {w.is_active ? 'Deactivate' : 'Activate'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {edit && (
        <Modal title="Add warehouse" onClose={() => setEdit(null)} footer={<button className="btn primary" disabled={!edit.code || !edit.name} onClick={async () => (await run(() => post('/api/v1/warehouses', edit), 'Warehouse added')) && setEdit(null)}>Add</button>}>
          <div className="modal-body">
            <label className="field">
              Code
              <input value={edit.code} onChange={(e) => setEdit({ ...edit, code: e.target.value.toUpperCase() })} maxLength={20} placeholder="SHOWROOM" autoFocus />
            </label>
            <label className="field">
              Name
              <input value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} placeholder="Andheri showroom" />
            </label>
            <label className="field wide">
              Address
              <input value={edit.address} onChange={(e) => setEdit({ ...edit, address: e.target.value })} />
            </label>
            <label className="field">
              State
              <input value={edit.state} onChange={(e) => setEdit({ ...edit, state: e.target.value })} />
            </label>
            <label className="row" style={{ alignSelf: 'end', height: 34 }}>
              <input type="checkbox" checked={edit.isDefault} onChange={(e) => setEdit({ ...edit, isDefault: e.target.checked })} /> Default
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}

function CategoriesTab({ canManage }: { canManage: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const { data: meta } = useMeta();
  const { data } = useQuery({ queryKey: ['categories'], queryFn: () => get<{ items: Json[] }>('/api/v1/product-categories') });
  const [name, setName] = useState('');
  const [parent, setParent] = useState('');
  const paths = new Map((meta?.objects.find((o) => o.key === 'product')?.fields.find((f) => f.key === 'category_id')?.options?.choices ?? []).map((c) => [c.value, c.label]));
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok);
      qc.invalidateQueries({ queryKey: ['categories'] });
      qc.invalidateQueries({ queryKey: ['meta'] });
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const items = [...(data?.items ?? [])].sort((a, b) => (paths.get(a.id) ?? a.name).localeCompare(paths.get(b.id) ?? b.name));
  return (
    <div className="panel-body stack">
      {canManage && (
        <form
          className="row"
          style={{ flexWrap: 'wrap' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (!name.trim()) return;
            void run(() => post('/api/v1/product-categories', { name, parentId: parent || null }), 'Category added').then(() => setName(''));
          }}
        >
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="New category, e.g. Sofas" style={{ maxWidth: 240 }} aria-label="Category name" />
          <select value={parent} onChange={(e) => setParent(e.target.value)} style={{ width: 'auto' }} aria-label="Parent category">
            <option value="">Top level</option>
            {items.map((c) => (
              <option key={c.id} value={c.id}>
                Inside {paths.get(c.id) ?? c.name}
              </option>
            ))}
          </select>
          <button className="btn primary sm">Add</button>
        </form>
      )}
      {!items.length ? (
        <Empty title="No categories yet">Group products (Furniture › Sofas, Lighting, Décor…) to filter stock and reports.</Empty>
      ) : (
        <table className="data">
          <tbody>
            {items.map((c) => (
              <tr key={c.id}>
                <td>{paths.get(c.id) ?? c.name}</td>
                <td className="small muted">{c.products} products</td>
                <td className="row" style={{ justifyContent: 'flex-end' }}>
                  {canManage && (
                    <>
                      <button
                        className="btn sm"
                        onClick={() => {
                          const n = window.prompt('Rename category', c.name);
                          if (n && n.trim() !== c.name) void run(() => patch(`/api/v1/product-categories/${c.id}`, { name: n.trim() }), 'Renamed');
                        }}
                      >
                        Rename
                      </button>
                      <button className="btn sm danger" onClick={() => window.confirm(`Delete “${c.name}” and its sub-categories? Products keep existing without a category.`) && run(() => del(`/api/v1/product-categories/${c.id}`), 'Category deleted')}>
                        Delete
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
