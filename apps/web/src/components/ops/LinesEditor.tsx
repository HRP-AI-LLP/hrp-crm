import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { get } from "../../lib/api";
import { money2 } from "../../lib/format";
import { computeLines } from "../QuoteEditor";
import type { QuoteLine } from "../QuoteDocument";

export interface DocLine extends QuoteLine {
  id?: string;
  [extra: string]: unknown;
}

interface ProductOpt {
  id: string;
  name: string;
  sku: string | null;
  unit: string | null;
  hsn_sac: string | null;
  tax_rate: number | null;
  list_price: number | null;
  cost_price: number | null;
  variant_options: string | null;
}

/** Products for line pickers (first 500, cached). */
export function useProductOptions() {
  return useQuery({
    queryKey: ["product-options"],
    queryFn: () =>
      get<{ items: ProductOpt[] }>(
        "/api/v1/records/product?limit=200&sort=name&dir=asc",
      ),
    staleTime: 120_000,
  });
}

const blank = (): DocLine => ({
  name: "",
  quantity: 1,
  unitPrice: 0,
  discountPct: 0,
  taxRate: 18,
});

/**
 * Line items for orders, purchase orders and invoices. Prices default from the product's list
 * price (sales) or cost price (purchases). `extraCols` shows progress columns (delivered, received …).
 */
export function LinesEditor({
  lines: initial,
  locked,
  priceFrom,
  currency = "INR",
  extraCols = [],
  taxLabel = "GST",
  saveLabel = "Save lines",
  hideTotals = false,
  onSave,
}: {
  lines: DocLine[];
  locked: boolean;
  priceFrom: "list_price" | "cost_price";
  currency?: string;
  extraCols?: { key: string; label: string }[];
  taxLabel?: string;
  saveLabel?: string;
  /** the caller shows its own totals (invoices: CGST/SGST/IGST from the server) */
  hideTotals?: boolean;
  onSave: (lines: DocLine[]) => Promise<unknown>;
}) {
  const [lines, setLines] = useState<DocLine[]>(initial);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const products = useProductOptions();
  useEffect(() => {
    setLines(initial);
    setDirty(false);
  }, [initial]);
  const calc = useMemo(() => computeLines(lines), [lines]);
  const edit = (i: number, patch: Partial<DocLine>) => {
    setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));
    setDirty(true);
  };
  const pick = (i: number, id: string) => {
    const p = products.data?.items.find((x) => x.id === id);
    if (!p) return edit(i, { productId: null });
    edit(i, {
      productId: id,
      name: p.name,
      unit: p.unit,
      hsnSac: p.hsn_sac,
      taxRate: Number(p.tax_rate ?? 18),
      unitPrice: Number(p[priceFrom] ?? p.list_price ?? 0),
    });
  };
  const save = async () => {
    setBusy(true);
    try {
      await onSave(lines.filter((l) => l.name.trim()));
      setDirty(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="stack">
      <div className="table-wrap">
        <table className="data qlines">
          <thead>
            <tr>
              <th style={{ width: 28 }}>#</th>
              <th style={{ minWidth: 220 }}>Item</th>
              <th style={{ width: 90 }}>HSN/SAC</th>
              <th style={{ width: 80 }} className="num">
                Qty
              </th>
              {extraCols.map((c) => (
                <th key={c.key} style={{ width: 84 }} className="num">
                  {c.label}
                </th>
              ))}
              <th style={{ width: 120 }} className="num">
                Rate
              </th>
              <th style={{ width: 72 }} className="num">
                Disc %
              </th>
              <th style={{ width: 72 }} className="num">
                {taxLabel} %
              </th>
              <th style={{ width: 120 }} className="num">
                Amount
              </th>
              {!locked && <th style={{ width: 70 }} />}
            </tr>
          </thead>
          <tbody>
            {calc.lines.map((l, i) => (
              <tr key={l.id ?? i}>
                <td className="muted">{i + 1}</td>
                <td>
                  {!locked && (
                    <select
                      aria-label={`Product for line ${i + 1}`}
                      value={l.productId ?? ""}
                      onChange={(e) => pick(i, e.target.value)}
                    >
                      <option value="">Custom item</option>
                      {products.data?.items.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                          {p.sku ? ` (${p.sku})` : ""}
                        </option>
                      ))}
                    </select>
                  )}
                  {locked ? (
                    <div>
                      <b>{l.name}</b>
                      {l.description && (
                        <div className="muted small">{l.description}</div>
                      )}
                    </div>
                  ) : (
                    <>
                      <input
                        aria-label={`Item name, line ${i + 1}`}
                        value={l.name}
                        onChange={(e) => edit(i, { name: e.target.value })}
                        placeholder="Item name"
                      />
                      <input
                        aria-label={`Description, line ${i + 1}`}
                        className="small"
                        value={l.description ?? ""}
                        onChange={(e) =>
                          edit(i, { description: e.target.value })
                        }
                        placeholder="Description (optional)"
                      />
                    </>
                  )}
                </td>
                <td>
                  {locked ? (
                    <span className="small">{l.hsnSac ?? "—"}</span>
                  ) : (
                    <input
                      aria-label={`HSN/SAC, line ${i + 1}`}
                      value={l.hsnSac ?? ""}
                      onChange={(e) => edit(i, { hsnSac: e.target.value })}
                    />
                  )}
                </td>
                <td className="num">
                  {locked ? (
                    Number(l.quantity)
                  ) : (
                    <input
                      aria-label={`Quantity, line ${i + 1}`}
                      className="num"
                      inputMode="decimal"
                      value={l.quantity}
                      onChange={(e) =>
                        edit(i, {
                          quantity: e.target.value as unknown as number,
                        })
                      }
                    />
                  )}
                </td>
                {extraCols.map((c) => (
                  <td key={c.key} className="num">
                    {Number((l as DocLine)[c.key] ?? 0)}
                  </td>
                ))}
                <td className="num">
                  {locked ? (
                    money2(l.unitPrice, currency)
                  ) : (
                    <input
                      aria-label={`Rate, line ${i + 1}`}
                      className="num"
                      inputMode="decimal"
                      value={l.unitPrice}
                      onChange={(e) =>
                        edit(i, {
                          unitPrice: e.target.value as unknown as number,
                        })
                      }
                    />
                  )}
                </td>
                <td className="num">
                  {locked ? (
                    `${Number(l.discountPct)}`
                  ) : (
                    <input
                      aria-label={`Discount, line ${i + 1}`}
                      className="num"
                      inputMode="decimal"
                      value={l.discountPct}
                      onChange={(e) =>
                        edit(i, {
                          discountPct: e.target.value as unknown as number,
                        })
                      }
                    />
                  )}
                </td>
                <td className="num">
                  {locked ? (
                    `${Number(l.taxRate)}`
                  ) : (
                    <select
                      aria-label={`${taxLabel}, line ${i + 1}`}
                      value={String(l.taxRate)}
                      onChange={(e) =>
                        edit(i, { taxRate: Number(e.target.value) })
                      }
                    >
                      {[...new Set([0, 5, 12, 18, 28, Number(l.taxRate)])]
                        .sort((a, b) => a - b)
                        .map((r) => (
                          <option key={r} value={r}>
                            {r}%
                          </option>
                        ))}
                    </select>
                  )}
                </td>
                <td className="num">
                  <b>{money2(l.lineTotal, currency)}</b>
                </td>
                {!locked && (
                  <td>
                    <button
                      className="btn ghost sm"
                      aria-label={`Remove line ${i + 1}`}
                      onClick={() => {
                        setLines((ls) => ls.filter((_, j) => j !== i));
                        setDirty(true);
                      }}
                    >
                      ✕
                    </button>
                  </td>
                )}
              </tr>
            ))}
            {!calc.lines.length && (
              <tr>
                <td
                  colSpan={9 + extraCols.length}
                  className="muted"
                  style={{ textAlign: "center", padding: 20 }}
                >
                  No lines yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div className="spread" style={{ alignItems: "flex-start" }}>
        {!locked ? (
          <div className="row">
            <button
              className="btn"
              onClick={() => {
                setLines((ls) => [...ls, blank()]);
                setDirty(true);
              }}
            >
              Add line
            </button>
            <button
              className="btn primary"
              disabled={!dirty || busy}
              onClick={save}
            >
              {busy ? "Saving…" : dirty ? saveLabel : "Saved"}
            </button>
          </div>
        ) : (
          <span />
        )}
        {!hideTotals && (
          <table className="qtotals">
            <tbody>
              <tr>
                <th>Subtotal</th>
                <td>{money2(calc.subtotal, currency)}</td>
              </tr>
              {calc.discountTotal > 0 && (
                <tr>
                  <th>Discount</th>
                  <td>− {money2(calc.discountTotal, currency)}</td>
                </tr>
              )}
              <tr>
                <th>{taxLabel}</th>
                <td>{money2(calc.taxTotal, currency)}</td>
              </tr>
              <tr className="grand">
                <th>Total</th>
                <td>{money2(calc.grandTotal, currency)}</td>
              </tr>
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

/** Lines in the API's input shape. */
export const toLineInput = (l: DocLine) => ({
  productId: l.productId ?? null,
  name: l.name.trim(),
  description: l.description || null,
  hsnSac: l.hsnSac || null,
  unit: l.unit || null,
  quantity: Number(l.quantity),
  unitPrice: Number(l.unitPrice),
  discountPct: Number(l.discountPct) || 0,
  taxRate: Number(l.taxRate) || 0,
});
