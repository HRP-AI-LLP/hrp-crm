/**
 * Billing & GST → GST portal: the GSTIN's connection (OTP session), filing calendar, ledgers and
 * notices, returns (prepare → save → status → proceed → summary → offset → file with EVC / DSC),
 * GSTR-2B into reconciliation and challans — through the GST Suvidha Provider the server uses
 * (India Compliance or WhiteBooks). Also the invoice panel
 * for the IRN (e-invoice) and the e-way bill.
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { useRef, useState } from "react";
import { del, get, patch, post } from "../../lib/api";
import { date, dateTime, money2 } from "../../lib/format";
import { Empty, Modal, Spinner, useToast } from "../ui";
import { SelectAll } from "../SelectAll";
import { Guide } from '../admin/ConnectionKeys';

type Json = Record<string, any>;
const ymNow = () => new Date().toISOString().slice(0, 7);
const ymPrev = () => {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
};
const toPeriod = (ym: string) => `${ym.slice(5, 7)}${ym.slice(0, 4)}`;
const periodLabel = (p: string) =>
  new Date(
    Date.UTC(Number(p.slice(2)), Number(p.slice(0, 2)) - 1, 1),
  ).toLocaleDateString("en-IN", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
const fyStart = () => {
  const d = new Date();
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
};

const STATUS: Record<string, [string, string]> = {
  prepared: ["Prepared", ""],
  saving: ["Processing on the portal", "info"],
  saved: ["Saved on the portal", "info"],
  error: ["Portal error", "bad"],
  submitted: ["Ready to file", "info"],
  offset: ["Liability offset", "info"],
  filed: ["Filed", "good"],
  due: ["Due", ""],
  overdue: ["Overdue", "bad"],
};
const RETURN_TYPES: [string, string, string][] = [
  ["GSTR1", "GSTR-1 (outward supplies)", "synapse"],
  ["GSTR3B", "GSTR-3B (summary return and payment)", "synapse"],
  ["ITC04", "ITC-04 (goods sent to job workers)", "synapse"],
  ["GSTR2X", "GSTR-2X (accept TDS / TCS credits)", "portal"],
  ["GSTR9", "GSTR-9 (annual return)", "portal"],
  ["GSTR7", "GSTR-7 (TDS deducted — for deductors)", "upload"],
  ["GSTR1A", "GSTR-1A (amendments)", "upload"],
  ["GSTR9C", "GSTR-9C (reconciliation statement)", "upload"],
  ["GSTR6", "GSTR-6 (input service distributor)", "upload"],
  ["GSTR8", "GSTR-8 (e-commerce operator TCS)", "upload"],
  ["CMP08", "CMP-08 (composition)", "upload"],
];

/** What the server's GST Suvidha Provider can do (from the cached connections list). */
function useGsp(): Json {
  const { data } = useQuery({
    queryKey: ["gst", "connections"],
    queryFn: () =>
      get<{ gsp: Json; connections: Json[] }>("/api/v1/gst/connections"),
  });
  return data?.gsp ?? {};
}

function useAct(keys: unknown[][]) {
  const qc = useQueryClient();
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok: string): Promise<T | null> => {
    try {
      const r = await fn();
      toast(ok);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      for (const k of keys) qc.invalidateQueries({ queryKey: k });
      return null;
    }
  };
}

function JsonBox({ value, height = 260 }: { value: unknown; height?: number }) {
  return (
    <pre
      className="small"
      style={{
        maxHeight: height,
        overflow: "auto",
        background: "var(--surface-2, #f6f7f9)",
        padding: 10,
        borderRadius: 8,
        margin: 0,
        whiteSpace: "pre-wrap",
        wordBreak: "break-word",
      }}
    >
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}
function saveJson(value: unknown, name: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(
    new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
  );
  a.download = name;
  a.click();
}

/* ───────────────────────── page ───────────────────────── */

export function GstPortal() {
  const { data, isLoading } = useQuery({
    queryKey: ["gst", "connections"],
    queryFn: () =>
      get<{ gsp: Json; connections: Json[] }>("/api/v1/gst/connections"),
  });
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<
    "overview" | "returns" | "portal" | "settings" | "log"
  >("overview");
  const [adding, setAdding] = useState(false);
  if (isLoading || !data)
    return (
      <div className="panel-body">
        <Spinner />
      </div>
    );
  const conn =
    data.connections.find((c) => c.id === sel) ?? data.connections[0];
  return (
    <div className="panel-body stack">
      <Guide id="gst" label="How the GST portal connection works" />
      {!data.gsp.configured && (
        <div
          className="panel"
          style={{ padding: 12, borderLeft: "4px solid var(--bad)" }}
        >
          <b>No GST Suvidha Provider is set up yet.</b> Add the API keys of
          gstinapi.in, India Compliance or WhiteBooks in{" "}
          <a href="/settings?keys=gst#keys">Settings → Connection keys → GST portal</a>{" "}
          — the guide there shows how to get them, and a workspace can use its
          own GSP account. Until then you can prepare returns and download the
          portal JSON.
        </div>
      )}
      {data.gsp.configured && data.gsp.sandbox && (
        <div className="muted small">
          Using {data.gsp.provider}'s <b>sandbox</b>: nothing reaches the real
          GST portal. The sandbox OTP is 575757.
        </div>
      )}
      {data.gsp.configured && !data.gsp.sandbox && (
        <div className="muted small">
          Through <b>{data.gsp.provider}</b>: returns go to the{" "}
          <b>live GST portal</b>; each call to the government system uses one
          API credit.
          {data.gsp.nicSandbox &&
            " E-invoice and e-way bill go to its test servers (test taxpayer)."}
        </div>
      )}
      {!conn || adding ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Add your GST registration</h2>
          </div>
          <RegistrationForm
            onDone={(id) => {
              setAdding(false);
              setSel(id);
            }}
            onCancel={conn ? () => setAdding(false) : undefined}
          />
        </section>
      ) : (
        <>
          <div
            className="row"
            style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}
          >
            {data.connections.length > 1 ? (
              <select value={conn.id} onChange={(e) => setSel(e.target.value)}>
                {data.connections.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.gstin} {c.legalName ? `· ${c.legalName}` : ""}
                  </option>
                ))}
              </select>
            ) : (
              <b>
                {conn.gstin} {conn.legalName ? `· ${conn.legalName}` : ""}
              </b>
            )}
            <button className="btn sm ghost" onClick={() => setAdding(true)}>
              + Another GSTIN
            </button>
          </div>
          <SessionBar
            conn={conn}
            configured={!!data.gsp.configured}
            sandbox={!!data.gsp.sandbox}
          />
          <div className="tabs" role="tablist" style={{ margin: 0 }}>
            {(
              [
                ["overview", "Overview & due dates"],
                ["returns", "Returns"],
                ["portal", "Ledgers, notices & payments"],
                ["settings", "Registration"],
                ["log", "Activity"],
              ] as const
            ).map(([k, l]) => (
              <button
                key={k}
                role="tab"
                aria-selected={tab === k}
                onClick={() => setTab(k)}
              >
                {l}
              </button>
            ))}
          </div>
          {tab === "overview" && <Overview conn={conn} onOpen={setTab} />}
          {tab === "returns" && <Returns conn={conn} />}
          {tab === "portal" && <PortalViews conn={conn} />}
          {tab === "settings" && (
            <RegistrationForm conn={conn} onDone={() => undefined} />
          )}
          {tab === "log" && <ActivityLog conn={conn} />}
        </>
      )}
    </div>
  );
}

/* ───────────────────────── session ───────────────────────── */

function SessionBar({
  conn,
  configured,
  sandbox,
}: {
  conn: Json;
  configured: boolean;
  sandbox: boolean;
}) {
  const act = useAct([["gst"]]);
  const [otp, setOtp] = useState("");
  const live = conn.status === "active";
  const chip = live
    ? ["Connected", "good"]
    : conn.status === "otp_sent"
      ? ["OTP sent", "warn"]
      : conn.status === "expired"
        ? ["Session ended", "warn"]
        : ["Not connected", ""];
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div
        className="row"
        style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}
      >
        <span>
          GST portal: <span className={`chip ${chip[1]}`}>{chip[0]}</span>
        </span>
        {live && conn.sessionExpiresAt && (
          <span className="muted small">
            until {dateTime(conn.sessionExpiresAt)} (renewed automatically while
            you work)
          </span>
        )}
        {!conn.gstUsername && (
          <span className="muted small">
            Enter the GST portal username under Registration first.
          </span>
        )}
        {conn.status === "otp_sent" ? (
          <>
            <input
              placeholder="OTP"
              inputMode="numeric"
              value={otp}
              onChange={(e) =>
                setOtp(e.target.value.replace(/\D/g, "").slice(0, 8))
              }
              style={{ width: 110 }}
            />
            <button
              className="btn sm primary"
              disabled={otp.length < 4}
              onClick={async () =>
                (await act(
                  () =>
                    post(`/api/v1/gst/connections/${conn.id}/verify`, { otp }),
                  "Connected to the GST portal",
                )) && setOtp("")
              }
            >
              Verify
            </button>
            <button
              className="btn sm ghost"
              onClick={() =>
                act(
                  () => post(`/api/v1/gst/connections/${conn.id}/otp`),
                  "A new OTP was sent",
                )
              }
            >
              Resend
            </button>
            {sandbox && (
              <span className="muted small">Sandbox OTP: 575757</span>
            )}
          </>
        ) : (
          !live && (
            <button
              className="btn sm primary"
              disabled={!configured || !conn.gstUsername}
              onClick={() =>
                act(
                  () => post(`/api/v1/gst/connections/${conn.id}/otp`),
                  "OTP sent to the mobile and email registered on the GST portal",
                )
              }
            >
              Connect (send OTP)
            </button>
          )
        )}
        {live && (
          <button
            className="btn sm ghost"
            onClick={() =>
              act(
                () => post(`/api/v1/gst/connections/${conn.id}/disconnect`),
                "Disconnected",
              )
            }
          >
            Disconnect
          </button>
        )}
      </div>
      {!live && (
        <div className="muted small" style={{ marginTop: 6 }}>
          Before the first connection, allow API access on gst.gov.in:{" "}
          <i>My Profile → Manage API Access → Yes</i>, choose the duration (up
          to 30 days), and select WhiteBooks as the GSP if asked.
        </div>
      )}
      {conn.lastError && (
        <div className="small" style={{ color: "var(--bad)", marginTop: 6 }}>
          Last error: {conn.lastError}
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── overview ───────────────────────── */

type GstTab = "overview" | "returns" | "portal" | "settings" | "log";
const cardOpen = (onOpen: (t: GstTab) => void, t: GstTab) => ({
  className: "panel kpi kpi-link",
  role: "button" as const,
  tabIndex: 0,
  onClick: () => onOpen(t),
  onKeyDown: (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onOpen(t);
    }
  },
});

function Overview({ conn, onOpen }: { conn: Json; onOpen: (t: GstTab) => void }) {
  const gsp = useGsp();
  const has = (k: string) => (gsp.views ?? []).includes(k);
  const act = useAct([["gst"]]);
  const { data } = useQuery({
    queryKey: ["gst", "overview", conn.id],
    queryFn: () => get<Json>(`/api/v1/gst/connections/${conn.id}/overview`),
  });
  const [show, setShow] = useState<"pending" | "all">("pending");
  const [open, setOpen] = useState<Json | null>(null);
  const [detail, setDetail] = useState<Json | null>(null);
  if (!data) return <Spinner />;
  const live = conn.status === "active";
  const bal = data.ledgerBalance?.data;
  const cash = bal?.cash_bal ?? {};
  const itc = bal?.itc_bal ?? {};
  const view = (kind: string, params: Json, ok: string) =>
    act(
      () =>
        post(
          `/api/v1/gst/connections/${conn.id}/views/${kind}?refresh=1`,
          params,
        ),
      ok,
    );
  const rows = show === "pending" ? data.pending : data.calendar;
  const ninetyAgo = new Date(Date.now() - 90 * 86_400_000)
    .toISOString()
    .slice(0, 10);
  return (
    <div className="stack">
      <div className="row" style={{ flexWrap: "wrap", gap: 8 }}>
        <button
          className="btn sm"
          disabled={!live && !gsp.publicTrack}
          onClick={() =>
            act(
              () =>
                post(`/api/v1/gst/connections/${conn.id}/sync-returns`, {
                  fyStart: fyStart(),
                }),
              "Return status updated from the portal",
            )
          }
        >
          Update filed returns from the portal
        </button>
        {has("ledger_balance") && (
          <button
            className="btn sm"
            disabled={!live}
            onClick={() =>
              view(
                "ledger_balance",
                { period: toPeriod(ymNow()) },
                "Balances updated",
              )
            }
          >
            Update cash & ITC balance
          </button>
        )}
        {has("notices") && (
          <button
            className="btn sm"
            disabled={!live}
            onClick={() =>
              view(
                "notices",
                { from: `${fyStart() - 1}-04-01` },
                "Notices updated",
              )
            }
          >
            Check notices
          </button>
        )}
        {has("challans") && (
          <button
            className="btn sm"
            disabled={!live}
            onClick={() =>
              view(
                "challans",
                { from: ninetyAgo, to: new Date().toISOString().slice(0, 10) },
                "Challans updated",
              )
            }
          >
            Challans (90 days)
          </button>
        )}
      </div>
      <div className="kpis" style={{ margin: 0 }}>
        <div {...cardOpen(onOpen, "portal")}>
          <div className="l">
            Cash ledger{" "}
            {data.ledgerBalance && (
              <span className="muted small">
                · {dateTime(data.ledgerBalance.fetched_at)}
              </span>
            )}
          </div>
          <div className="v">
            {bal
              ? money2(
                  Number(cash.igst_tot_bal ?? 0) +
                    Number(cash.cgst_tot_bal ?? 0) +
                    Number(cash.sgst_tot_bal ?? 0) +
                    Number(cash.cess_tot_bal ?? 0),
                )
              : "—"}
          </div>
          {bal && (
            <div className="muted small">
              IGST {money2(cash.igst_tot_bal ?? 0)} · CGST{" "}
              {money2(cash.cgst_tot_bal ?? 0)} · SGST{" "}
              {money2(cash.sgst_tot_bal ?? 0)}
            </div>
          )}
        </div>
        <div {...cardOpen(onOpen, "portal")}>
          <div className="l">ITC (credit ledger)</div>
          <div className="v">
            {bal
              ? money2(
                  Number(itc.igst_bal ?? 0) +
                    Number(itc.cgst_bal ?? 0) +
                    Number(itc.sgst_bal ?? 0) +
                    Number(itc.cess_bal ?? 0),
                )
              : "—"}
          </div>
          {bal && (
            <div className="muted small">
              IGST {money2(itc.igst_bal ?? 0)} · CGST{" "}
              {money2(itc.cgst_bal ?? 0)} · SGST {money2(itc.sgst_bal ?? 0)}
            </div>
          )}
        </div>
        <div {...cardOpen(onOpen, "returns")}>
          <div className="l">Returns to file now</div>
          <div
            className="v"
            style={{
              color: data.pending.some((p: Json) => p.status === "overdue")
                ? "var(--bad)"
                : undefined,
            }}
          >
            {data.pending.length}
          </div>
          <div className="muted small">
            {data.pending.filter((p: Json) => p.status === "overdue").length}{" "}
            overdue
            {data.overdueEarlier > 0 &&
              ` · ${data.overdueEarlier} earlier this year not marked filed (update from the portal)`}
          </div>
        </div>
      </div>
      {data.notices?.data && (
        <details className="panel" style={{ padding: 12 }}>
          <summary>
            Notices and orders on the portal{" "}
            <span className="muted small">
              · {dateTime(data.notices.fetched_at)}
            </span>
          </summary>
          <JsonBox value={data.notices.data} />
        </details>
      )}
      <section className="panel">
        <div className="panel-head">
          <h2>Filing calendar · FY {data.fy}</h2>
          <div className="row">
            <button
              className={`btn sm ${show === "pending" ? "primary" : ""}`}
              onClick={() => setShow("pending")}
            >
              Due soon
            </button>
            <button
              className={`btn sm ${show === "all" ? "primary" : ""}`}
              onClick={() => setShow("all")}
            >
              All
            </button>
          </div>
        </div>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Return</th>
                <th>Period</th>
                <th>Due</th>
                <th>Status</th>
                <th>ARN</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r: Json) => (
                <tr
                  key={`${r.returnType}${r.period}`}
                  className="clickable"
                  style={{ cursor: "pointer" }}
                  title="Open the details"
                  onClick={() => setDetail(r)}
                >
                  <td>{r.label}</td>
                  <td>{r.periodLabel}</td>
                  <td>{date(r.dueDate)}</td>
                  <td>
                    <span className={`chip ${STATUS[r.status]?.[1] ?? ""}`}>
                      {STATUS[r.status]?.[0] ?? r.status}
                    </span>
                    {r.source === "portal" && (
                      <span className="muted small"> (portal)</span>
                    )}
                  </td>
                  <td className="small">{r.arn ?? ""}</td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {r.status === "filed" ? (
                      <button className="btn sm" onClick={() => setDetail(r)}>
                        View
                      </button>
                    ) : (
                      <button className="btn sm" onClick={() => setOpen(r)}>
                        {r.filingId ? "Continue" : "Prepare"}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
              {!rows.length && (
                <tr>
                  <td
                    colSpan={6}
                    className="muted"
                    style={{ textAlign: "center", padding: 20 }}
                  >
                    Nothing to file right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="muted small" style={{ padding: "8px 16px" }}>
          Due dates are the regular ones; check gst.gov.in for extensions.
          Change monthly / quarterly filing under Registration.
        </div>
      </section>
      {detail && (
        <ReturnDetail
          conn={conn}
          item={detail}
          onClose={() => setDetail(null)}
          onOpenFiling={(r) => {
            setDetail(null);
            setOpen(r);
          }}
        />
      )}
      {open &&
        (open.filingId ? (
          <FilingWizard
            id={open.filingId}
            conn={conn}
            onClose={() => setOpen(null)}
          />
        ) : (
          <NewReturn
            conn={conn}
            preset={{ returnType: open.returnType, period: open.period }}
            onClose={() => setOpen(null)}
          />
        ))}
    </div>
  );
}

/* ───────────────────────── one return, one period ───────────────────────── */

const n2 = (v: unknown) => money2(Number(v ?? 0));

function TaxRows({ rows }: { rows: [string, Json | null | undefined][] }) {
  return (
    <div className="table-wrap">
      <table className="data">
        <thead>
          <tr>
            <th />
            <th style={{ textAlign: "right" }}>Taxable</th>
            <th style={{ textAlign: "right" }}>IGST</th>
            <th style={{ textAlign: "right" }}>CGST</th>
            <th style={{ textAlign: "right" }}>SGST</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([label, v]) => (
            <tr key={label}>
              <td>{label}</td>
              <td style={{ textAlign: "right" }}>
                {v?.taxable === undefined ? "" : n2(v.taxable)}
              </td>
              <td style={{ textAlign: "right" }}>{n2(v?.igst)}</td>
              <td style={{ textAlign: "right" }}>
                {v?.cgst === undefined ? "" : n2(v.cgst)}
              </td>
              <td style={{ textAlign: "right" }}>
                {v?.sgst === undefined ? "" : n2(v.sgst)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ReturnDetail({
  conn,
  item,
  onClose,
  onOpenFiling,
}: {
  conn: Json;
  item: Json;
  onClose: () => void;
  onOpenFiling: (r: Json) => void;
}) {
  const act = useAct([
    ["gst", "return", conn.id, item.returnType, item.period],
  ]);
  const { data, error } = useQuery({
    queryKey: ["gst", "return", conn.id, item.returnType, item.period],
    queryFn: () =>
      get<Json>(
        `/api/v1/gst/connections/${conn.id}/returns/${item.returnType}/${item.period}`,
      ),
  });
  const [summary, setSummary] = useState<Json | null>(null);
  const live = conn.status === "active";
  const fetchSummary = async (refresh: boolean) => {
    const r = await act(
      () =>
        post<Json>(
          `/api/v1/gst/connections/${conn.id}/views/${data!.portalSummaryView}${refresh ? "?refresh=1" : ""}`,
          { period: item.period },
        ),
      refresh ? "Fetched from the portal" : "Portal figures loaded",
    );
    if (r) setSummary({ data: r.data, fetchedAt: r.fetchedAt });
  };
  const p = data?.portal;
  const f = data?.filing;
  const b = data?.books;
  const ps = summary ?? data?.portalSummary;
  const title = `${item.label} · ${item.periodLabel ?? periodLabel(item.period)}`;
  return (
    <Modal
      title={title}
      onClose={onClose}
      wide
      footer={
        <>
          {data && (
            <button
              className="btn"
              onClick={() =>
                saveJson(
                  data,
                  `${item.returnType}-${item.period}-${conn.gstin}.json`,
                )
              }
            >
              Download JSON
            </button>
          )}
          {item.status !== "filed" && (
            <button className="btn primary" onClick={() => onOpenFiling(item)}>
              {item.filingId ? "Continue the return" : "Prepare the return"}
            </button>
          )}
          {item.status === "filed" && f && (
            <button className="btn primary" onClick={() => onOpenFiling(item)}>
              Open the filing in SanchalanOS
            </button>
          )}
        </>
      }
    >
      <div className="modal-body stack">
        {error ? (
          <div className="muted">{(error as Error).message}</div>
        ) : !data ? (
          <Spinner />
        ) : (
          <div className="stack">
            <div className="kpis" style={{ margin: 0 }}>
              <div className="panel kpi">
                <div className="l">Status</div>
                <div className="v" style={{ fontSize: 18 }}>
                  <span className={`chip ${STATUS[item.status]?.[1] ?? ""}`}>
                    {STATUS[item.status]?.[0] ?? item.status}
                  </span>
                </div>
                <div className="muted small">
                  {item.source === "portal"
                    ? "Filed on the portal (outside SanchalanOS)"
                    : item.source === "synapse"
                      ? "Filed from SanchalanOS"
                      : `Due ${date(item.dueDate)}`}
                </div>
              </div>
              <div className="panel kpi">
                <div className="l">Filed on</div>
                <div className="v" style={{ fontSize: 18 }}>
                  {f?.filedAt ? date(f.filedAt) : (p?.date ?? "—")}
                </div>
                <div className="muted small">
                  {p?.mode ? `Mode: ${p.mode}` : ""}
                  {p?.valid ? ` · Valid: ${p.valid}` : ""}
                </div>
              </div>
              <div className="panel kpi">
                <div className="l">ARN</div>
                <div
                  className="v"
                  style={{ fontSize: 16, wordBreak: "break-all" }}
                >
                  {f?.arn ?? p?.arn ?? "—"}
                </div>
                <div className="muted small">
                  {p?.fetchedAt
                    ? `Portal list updated ${dateTime(p.fetchedAt)}`
                    : "Not in the portal's filed list (update it from the Overview)"}
                </div>
              </div>
            </div>

            {b?.kind === "GSTR1" && (
              <section>
                <h3 style={{ margin: "4px 0 8px" }}>
                  What your books show for this month
                </h3>
                <TaxRows
                  rows={[["Outward supplies (net of credit notes)", b.totals]]}
                />
                <div className="muted small" style={{ marginTop: 6 }}>
                  B2B invoices {b.counts?.b2b ?? 0} · B2C large{" "}
                  {b.counts?.b2cl ?? 0} · B2C small rows {b.counts?.b2cs ?? 0} ·
                  Credit/debit notes {b.counts?.cdnr ?? 0} · Exports{" "}
                  {b.counts?.exp ?? 0} · Cancelled {b.counts?.cancelled ?? 0}
                </div>
              </section>
            )}
            {b?.kind === "GSTR3B" && (
              <section>
                <h3 style={{ margin: "4px 0 8px" }}>
                  What your books show for this month
                </h3>
                <TaxRows
                  rows={[
                    ["3.1(a) Outward taxable supplies", b.outward],
                    ["3.1(b) Zero-rated (exports, SEZ)", b.zeroRated],
                    ["3.1(c) Nil-rated / exempt", { taxable: b.nilExempt }],
                    [
                      "3.1(d) Inward supplies on reverse charge",
                      b.inwardReverseCharge,
                    ],
                    ["4 Eligible ITC", b.itc],
                    ["Tax liability", b.liability],
                    ["Payable in cash", b.payableInCash],
                    ["Credit carried forward", b.creditCarriedForward],
                  ]}
                />
              </section>
            )}
            {b && (
              <div className="muted small">
                Worked out from your invoices, bills and expenses as they stand
                today; if something was changed after filing, it will differ
                from what was filed.
              </div>
            )}

            {data.portalSummaryView && (
              <section>
                <div
                  className="row"
                  style={{ justifyContent: "space-between" }}
                >
                  <h3 style={{ margin: "4px 0 8px" }}>
                    The portal's figures{" "}
                    {ps?.fetchedAt && (
                      <span className="muted small">
                        · {dateTime(ps.fetchedAt)}
                      </span>
                    )}
                  </h3>
                  <div className="row">
                    {!ps && (
                      <button
                        className="btn sm"
                        disabled={!live}
                        onClick={() => fetchSummary(false)}
                      >
                        Fetch from the portal
                      </button>
                    )}
                    {ps && (
                      <button
                        className="btn sm"
                        disabled={!live}
                        onClick={() => fetchSummary(true)}
                      >
                        Refresh
                      </button>
                    )}
                  </div>
                </div>
                {ps ? (
                  <JsonBox value={ps.data} />
                ) : (
                  <div className="muted small">
                    Not fetched yet. Fetching is a paid call and needs an active
                    portal session; the answer is kept for next time.
                  </div>
                )}
              </section>
            )}
            {!data.portalSummaryView && item.source === "portal" && (
              <div className="muted small">
                Your GST Suvidha Provider gives the filed list (ARN, date,
                status) but not the filed return's figures. To see the exact
                filed figures, open the return on gst.gov.in (Returns Dashboard
                → View) or download its PDF there.
              </div>
            )}

            {f && (
              <details className="panel" style={{ padding: 12 }}>
                <summary>
                  What SanchalanOS sent{" "}
                  <span className="muted small">
                    · {STATUS[f.status]?.[0] ?? f.status}
                    {f.portalStatus === "TEST" ? " · test mode" : ""}
                  </span>
                </summary>
                {f.summary && (
                  <>
                    <div
                      className="muted small"
                      style={{ margin: "8px 0 4px" }}
                    >
                      Portal summary
                    </div>
                    <JsonBox value={f.summary} />
                  </>
                )}
                <div className="muted small" style={{ margin: "8px 0 4px" }}>
                  Return JSON
                </div>
                <JsonBox value={f.payload} />
              </details>
            )}
            {p && (
              <details className="panel" style={{ padding: 12 }}>
                <summary>The portal's record</summary>
                <JsonBox value={p.raw} height={160} />
              </details>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── returns ───────────────────────── */

function Returns({ conn }: { conn: Json }) {
  const { data } = useQuery({
    queryKey: ["gst", "filings", conn.id],
    queryFn: () => get<Json[]>(`/api/v1/gst/connections/${conn.id}/filings`),
  });
  const [open, setOpen] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Returns</h2>
        <button className="btn sm primary" onClick={() => setCreating(true)}>
          Prepare a return
        </button>
      </div>
      {!data ? (
        <Spinner />
      ) : !data.length ? (
        <Empty title="No returns prepared yet">
          GSTR-1, GSTR-3B and ITC-04 are built from your invoices, bills and job
          work. Others start from the portal's figures or from portal JSON.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Return</th>
                <th>Period</th>
                <th>Status</th>
                <th>From</th>
                <th>ARN</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.map((f) => (
                <tr
                  key={f.id}
                  className="clickable"
                  onClick={() => setOpen(f.id)}
                  onDoubleClick={() => setOpen(f.id)}
                  style={{ cursor: "pointer" }}
                >
                  <td>{f.label}</td>
                  <td>{periodLabel(f.period)}</td>
                  <td>
                    <span className={`chip ${STATUS[f.status]?.[1] ?? ""}`}>
                      {STATUS[f.status]?.[0] ?? f.status}
                    </span>
                  </td>
                  <td className="small">
                    {f.source === "synapse"
                      ? "SanchalanOS"
                      : f.source === "portal"
                        ? "Portal"
                        : "Uploaded JSON"}
                  </td>
                  <td className="small">{f.arn ?? ""}</td>
                  <td className="small">{dateTime(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {creating && (
        <NewReturn
          conn={conn}
          onClose={() => setCreating(false)}
          onCreated={(id) => {
            setCreating(false);
            setOpen(id);
          }}
        />
      )}
      {open && (
        <FilingWizard id={open} conn={conn} onClose={() => setOpen(null)} />
      )}
    </section>
  );
}

function NewReturn({
  conn,
  preset,
  onClose,
  onCreated,
}: {
  conn: Json;
  preset?: { returnType: string; period: string };
  onClose: () => void;
  onCreated?: (id: string) => void;
}) {
  const act = useAct([["gst"]]);
  const [f, setF] = useState({
    returnType: preset?.returnType ?? "GSTR1",
    month: preset
      ? `${preset.period.slice(2)}-${preset.period.slice(0, 2)}`
      : ymPrev(),
    from: `${fyStart() - 1}-04-01`,
    to: `${fyStart()}-03-31`,
    json: "" as string,
  });
  const [created, setCreated] = useState<string | null>(null);
  const gsp = useGsp();
  const base = RETURN_TYPES.find(([k]) => k === f.returnType)?.[2] ?? "upload";
  const kind =
    base === "portal" &&
    !(gsp.views ?? []).includes(
      f.returnType === "GSTR9" ? "gstr9_autocalc" : "gstr2x",
    )
      ? "upload"
      : base;
  const canSend = (gsp.forms ?? []).includes(f.returnType);
  const period = toPeriod(f.month);
  const go = async () => {
    let r: Json | null = null;
    if (kind === "synapse")
      r = await act(
        () =>
          post<Json>(`/api/v1/gst/connections/${conn.id}/filings`, {
            returnType: f.returnType,
            period,
            ...(f.returnType === "ITC04" ? { from: f.from, to: f.to } : {}),
          }),
        "Prepared",
      );
    else if (kind === "portal")
      r = await act(
        () =>
          post<Json>(`/api/v1/gst/connections/${conn.id}/filings/from-portal`, {
            returnType: f.returnType,
            period,
          }),
        "Prepared from the portal",
      );
    else {
      let payload: unknown;
      try {
        payload = JSON.parse(f.json);
      } catch {
        window.alert("That is not valid JSON");
        return;
      }
      r = await act(
        () =>
          post<Json>(`/api/v1/gst/connections/${conn.id}/filings`, {
            returnType: f.returnType,
            period,
            payload,
          }),
        "Prepared from your JSON",
      );
    }
    if (r?.id) {
      if (onCreated) onCreated(r.id);
      else setCreated(r.id);
    }
  };
  if (created)
    return <FilingWizard id={created} conn={conn} onClose={onClose} />;
  return (
    <Modal
      title="Prepare a return"
      onClose={onClose}
      footer={
        <button className="btn primary" onClick={go}>
          Prepare
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Return
          <select
            value={f.returnType}
            onChange={(e) => setF({ ...f, returnType: e.target.value })}
          >
            {RETURN_TYPES.map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <label className="field">
          {["GSTR9", "GSTR9C", "ITC04"].includes(f.returnType)
            ? "Last month of the period"
            : conn.filingFrequency === "quarterly"
              ? "Last month of the quarter"
              : "Month"}
          <input
            type="month"
            value={f.month}
            onChange={(e) => setF({ ...f, month: e.target.value })}
          />
        </label>
        {f.returnType === "ITC04" && (
          <>
            <label className="field">
              From
              <input
                type="date"
                value={f.from}
                onChange={(e) => setF({ ...f, from: e.target.value })}
              />
            </label>
            <label className="field">
              To
              <input
                type="date"
                value={f.to}
                onChange={(e) => setF({ ...f, to: e.target.value })}
              />
            </label>
          </>
        )}
        <div className="wide muted small">
          {kind === "synapse" &&
            "Built from issued invoices and credit notes, posted bills and expenses, and job work in SanchalanOS. You can check and download the JSON before anything goes to the portal."}
          {kind === "portal" &&
            (f.returnType === "GSTR9"
              ? "Starts from the portal's auto-calculated GSTR-9 (from your GSTR-1 and 3B). Needs a live portal session."
              : "Fetches the TDS / TCS credits deductors reported for you (e.g. a government buyer's GST TDS) and accepts them all, so they reach your cash ledger. Needs a live portal session.")}
          {kind === "upload" &&
            "Paste the portal-format JSON (from the GST offline tool or your accountant's software). It must be for this GSTIN."}
          {!canSend &&
            gsp.configured &&
            ` ${gsp.provider} can't send this return: you'll download the JSON and upload it on gst.gov.in.`}
        </div>
        {kind === "upload" && (
          <label className="field wide">
            Portal JSON
            <textarea
              rows={8}
              value={f.json}
              onChange={(e) => setF({ ...f, json: e.target.value })}
              placeholder='{"gstin": "…", "fp": "…", …}'
            />
            <input
              type="file"
              accept=".json,application/json"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setF({ ...f, json: await file.text() });
              }}
            />
          </label>
        )}
      </div>
    </Modal>
  );
}

const STEPS = ["prepared", "saving", "saved", "submitted", "offset", "filed"];

function FilingWizard({
  id,
  conn,
  onClose,
}: {
  id: string;
  conn: Json;
  onClose: () => void;
}) {
  const gsp = useGsp();
  const steps: Json = gsp.steps ?? {};
  const otpOnSave = !!steps.gstr1OtpOnSave;
  const act = useAct([["gst"]]);
  const { data: f } = useQuery({
    queryKey: ["gst", "filing", id],
    queryFn: () => get<Json>(`/api/v1/gst/filings/${id}`),
  });
  const [offset, setOffset] = useState<Json | null>(null);
  const [offsetText, setOffsetText] = useState("");
  const [file, setFile] = useState({
    mode: "evc",
    pan: conn.signatoryPan ?? "",
    otp: "",
    declaration: false,
  });
  if (!f)
    return (
      <Modal title="Return" onClose={onClose}>
        <div className="modal-body">
          <Spinner />
        </div>
      </Modal>
    );
  const live = conn.status === "active";
  const st = f.status as string;
  const call = (path: string, ok: string, body?: unknown) =>
    act(() => post<Json>(`/api/v1/gst/filings/${id}/${path}`, body), ok);
  const at = (s: string) => STEPS.indexOf(st) >= STEPS.indexOf(s);
  const canFile =
    f.summary &&
    ((f.canOffset && st === "offset") ||
      (!f.canOffset &&
        (f.needsProceed
          ? st === "submitted"
          : ["saved", "submitted"].includes(st))));
  return (
    <Modal
      title={`${f.label} · ${periodLabel(f.period)}`}
      onClose={onClose}
      wide
    >
      <div className="modal-body stack">
        <div
          className="row"
          style={{ flexWrap: "wrap", gap: 8, alignItems: "center" }}
        >
          <span className={`chip ${STATUS[st]?.[1] ?? ""}`}>
            {STATUS[st]?.[0] ?? st}
          </span>
          {f.refId && (
            <span className="muted small">
              Reference {f.refId}
              {f.portalStatus ? ` · ${f.portalStatus}` : ""}
            </span>
          )}
          {f.arn && <b>ARN {f.arn}</b>}
          {f.portalStatus === "TEST" && (
            <span className="chip warn">
              Test mode run — nothing reached the portal
            </span>
          )}
          {f.filedAt && (
            <span className="muted small">
              filed {dateTime(f.filedAt)} by {f.filingMode?.toUpperCase()}
            </span>
          )}
        </div>
        {!live && st !== "filed" && (
          <div className="small" style={{ color: "var(--bad)" }}>
            Connect to the GST portal (OTP) to send this return.
          </div>
        )}

        <details open={st === "prepared"}>
          <summary>
            <b>1. What will be sent</b>{" "}
            <span className="muted small">
              (
              {f.source === "synapse"
                ? "from SanchalanOS records"
                : f.source === "portal"
                  ? "from the portal's figures"
                  : "uploaded JSON"}
              )
            </span>
          </summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <JsonBox value={f.payload} />
            <div className="row">
              <button
                className="btn sm"
                onClick={() =>
                  saveJson(
                    f.payload,
                    `${conn.gstin}-${f.returnType}-${f.period}.json`,
                  )
                }
              >
                Download JSON (for the offline tool)
              </button>
            </div>
          </div>
        </details>

        <div className="stack">
          <b>2. Save to the portal</b>
          <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
            {!f.canSend && (
              <div className="small">
                {gsp.provider ?? "The GST Suvidha Provider"} can't send{" "}
                {f.label}. Use <b>Download JSON</b> above and upload it on
                gst.gov.in (Returns → offline upload).
              </div>
            )}
            <button
              className="btn sm primary"
              disabled={
                !live ||
                !f.canSend ||
                !["prepared", "error", "saved"].includes(st)
              }
              onClick={() => call("save", "Sent; the portal is processing it")}
            >
              {st === "prepared" ? "Save to the portal" : "Save again"}
            </button>
            {otpOnSave && f.canSend && (
              <span className="muted small">
                Saving also proceeds to file, fetches the summary and sends the
                filing OTP to the signatory (
                {conn.signatoryPan || "set the PAN under Registration"}).
              </span>
            )}
            {steps.status !== false && (
              <button
                className="btn sm"
                disabled={!live || !f.refId || st === "filed"}
                onClick={() => call("status", "Status updated")}
              >
                Check status
              </button>
            )}
            {["GSTR1", "GSTR1A"].includes(f.returnType) &&
              ["saved", "error"].includes(st) && (
                <button
                  className="btn sm ghost"
                  disabled={!live}
                  onClick={() =>
                    window.confirm(
                      "Delete all the data saved on the portal for this return?",
                    ) && call("reset", "Reset on the portal")
                  }
                >
                  Reset portal data
                </button>
              )}
          </div>
          {f.errorReport && (
            <div>
              <div className="small" style={{ color: "var(--bad)" }}>
                The portal rejected some data. Fix it in SanchalanOS, prepare again
                and save.
              </div>
              <JsonBox value={f.errorReport} height={180} />
            </div>
          )}
        </div>

        {f.needsProceed && (
          <div className="stack">
            <b>3. {f.returnType === "GSTR3B" ? "Submit" : "Proceed to file"}</b>
            <div className="muted small">
              {f.returnType === "GSTR3B"
                ? "The portal freezes the figures; after this they can only be offset and filed."
                : "The portal freezes the saved data and works out the summary."}
            </div>
            <div className="row">
              <button
                className="btn sm primary"
                disabled={!live || st !== "saved"}
                onClick={() =>
                  call("proceed", "Done; check the status in a moment")
                }
              >
                {f.returnType === "GSTR3B"
                  ? "Submit GSTR-3B"
                  : "Proceed to file"}
              </button>
              {st === "submitted" && f.refId && (
                <button
                  className="btn sm"
                  disabled={!live}
                  onClick={() => call("status", "Status updated")}
                >
                  Check status
                </button>
              )}
            </div>
          </div>
        )}

        <div className="stack">
          <b>{f.needsProceed ? "4" : "3"}. Summary on the portal</b>
          {steps.summary !== false ? (
            <div className="row">
              <button
                className="btn sm"
                disabled={!live || !at("saved") || st === "error"}
                onClick={() => call("summary", "Summary fetched")}
              >
                {f.summary ? "Fetch again" : "Fetch summary"}
              </button>
            </div>
          ) : (
            !f.summary && (
              <div className="muted small">It comes back when you save.</div>
            )
          )}
          {f.summary && (
            <details>
              <summary>Summary (this is what gets filed)</summary>
              <JsonBox value={f.summary} />
            </details>
          )}
        </div>

        {f.canOffset && (
          <div className="stack">
            <b>4. Pay the liability (offset)</b>
            <div className="muted small">
              Forward-charge tax is paid from ITC first (IGST credit, then CGST
              / SGST credit); reverse-charge tax, interest and late fee from the
              cash ledger. If cash falls short, create a challan under Ledgers,
              notices & payments and pay it first.
            </div>
            <div className="row" style={{ gap: 8 }}>
              <button
                className="btn sm"
                disabled={
                  !live ||
                  !f.summary ||
                  !["saved", "submitted", "error"].includes(st)
                }
                onClick={async () => {
                  const r = await call("offset/propose", "Offset worked out");
                  if (r) {
                    setOffset(r);
                    setOffsetText(JSON.stringify(r.offset, null, 2));
                  }
                }}
              >
                Work out the offset
              </button>
            </div>
            {offset && (
              <>
                <table className="data small">
                  <thead>
                    <tr>
                      <th />
                      <th className="num">IGST</th>
                      <th className="num">CGST</th>
                      <th className="num">SGST</th>
                      <th className="num">Cess</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(["cashNeeded", "cashAvailable", "shortfall"] as const)
                      .filter((k) => offset[k])
                      .map((k) => (
                        <tr
                          key={k}
                          style={
                            k === "shortfall"
                              ? { color: "var(--bad)" }
                              : undefined
                          }
                        >
                          <td>
                            {k === "cashNeeded"
                              ? "To pay in cash"
                              : k === "cashAvailable"
                                ? "Cash ledger"
                                : "Short"}
                          </td>
                          {["igst", "cgst", "sgst", "cess"].map((h) => (
                            <td key={h} className="num">
                              {money2(offset[k][h] ?? 0)}
                            </td>
                          ))}
                        </tr>
                      ))}
                  </tbody>
                </table>
                {offset.note && <div className="small">{offset.note}</div>}
                <label className="field">
                  Offset (edit only if you know the portal format)
                  <textarea
                    rows={8}
                    value={offsetText}
                    onChange={(e) => setOffsetText(e.target.value)}
                    style={{ fontFamily: "monospace", fontSize: 12 }}
                  />
                </label>
                <div className="row">
                  <button
                    className="btn sm primary"
                    disabled={!live}
                    onClick={async () => {
                      let body: unknown;
                      try {
                        body = JSON.parse(offsetText);
                      } catch {
                        window.alert("That is not valid JSON");
                        return;
                      }
                      if (
                        window.confirm(
                          "Pay the GSTR-3B liability from the ledgers as shown? This debits your cash and credit ledgers on the portal.",
                        )
                      )
                        await call("offset", "Liability offset", body);
                    }}
                  >
                    Offset liability
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        <div className="stack">
          <b>{f.canOffset || f.needsProceed ? "5" : "4"}. File</b>
          {st === "filed" ? (
            <div>Filed{f.arn ? ` · ARN ${f.arn}` : ""}.</div>
          ) : (
            <>
              <div className="grid2">
                <label className="field">
                  Sign with
                  <select
                    value={file.mode}
                    onChange={(e) => setFile({ ...file, mode: e.target.value })}
                  >
                    <option value="evc">EVC (OTP to the signatory)</option>
                    {gsp.dsc && (
                      <option value="dsc">
                        DSC (registered on the GST portal)
                      </option>
                    )}
                  </select>
                </label>
                <label className="field">
                  Authorised signatory's PAN
                  <input
                    value={file.pan}
                    onChange={(e) =>
                      setFile({
                        ...file,
                        pan: e.target.value.toUpperCase().slice(0, 10),
                      })
                    }
                    placeholder="ABCDE1234F"
                  />
                </label>
                {file.mode === "evc" && (
                  <label className="field">
                    EVC OTP
                    <div className="row" style={{ gap: 6 }}>
                      <input
                        inputMode="numeric"
                        value={file.otp}
                        onChange={(e) =>
                          setFile({
                            ...file,
                            otp: e.target.value.replace(/\D/g, "").slice(0, 6),
                          })
                        }
                        style={{ width: 110 }}
                      />
                      {otpOnSave && f.returnType === "GSTR1" ? (
                        <span className="muted small">
                          Sent when you saved; save again for a new one.
                        </span>
                      ) : (
                        <button
                          className="btn sm"
                          disabled={
                            !live ||
                            !canFile ||
                            !/^[A-Z]{5}\d{4}[A-Z]$/.test(file.pan)
                          }
                          onClick={() =>
                            call("evc-otp", "OTP sent to the signatory", {
                              pan: file.pan,
                            })
                          }
                        >
                          Send OTP
                        </button>
                      )}
                    </div>
                  </label>
                )}
                <label
                  className="wide row"
                  style={{ gap: 8, alignItems: "flex-start" }}
                >
                  <input
                    type="checkbox"
                    checked={file.declaration}
                    onChange={(e) =>
                      setFile({ ...file, declaration: e.target.checked })
                    }
                  />
                  <span className="small">
                    I hereby solemnly affirm and declare that the information
                    given herein above is true and correct to the best of my
                    knowledge and belief and nothing has been concealed
                    therefrom.
                  </span>
                </label>
              </div>
              <div className="row">
                <button
                  className="btn primary"
                  disabled={
                    !live ||
                    !canFile ||
                    !file.declaration ||
                    (file.mode === "evc" && file.otp.length !== 6)
                  }
                  onClick={() =>
                    window.confirm(
                      `File ${f.label} for ${periodLabel(f.period)}? A filed return cannot be changed.`,
                    ) &&
                    call(
                      "file",
                      gsp.sandbox ? "Test run done (nothing filed)" : "Filed",
                      {
                        mode: file.mode,
                        pan: file.pan || null,
                        otp: file.otp || null,
                        declaration: true,
                      },
                    ).then((r) => r?.testMode && window.alert(r.note))
                  }
                >
                  File {f.label}
                </button>
              </div>
              {!canFile && (
                <div className="muted small">
                  Filing opens once the summary is fetched
                  {f.needsProceed ? " after proceeding to file" : ""}
                  {f.canOffset ? " and the liability is offset" : ""}.
                </div>
              )}
            </>
          )}
        </div>

        {f.events?.length > 0 && (
          <details>
            <summary>Activity</summary>
            <table className="data small">
              <tbody>
                {f.events.map((e: Json, i: number) => (
                  <tr key={i}>
                    <td>{dateTime(e.created_at)}</td>
                    <td>{e.action}</td>
                    <td>{e.ok ? "✓" : "✗"}</td>
                    <td>{e.message ?? ""}</td>
                    <td>{e.by ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        )}
      </div>
    </Modal>
  );
}

/* ───────────────────────── ledgers, notices, 2B, challans ───────────────────────── */

/* ───────────────────────── GSTR-2B over a range ───────────────────────── */

/** months YYYY-MM from `from` to `to`, inclusive */
function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let y = Number(from.slice(0, 4));
  let m = Number(from.slice(5, 7));
  const end = Number(to.slice(0, 4)) * 12 + Number(to.slice(5, 7));
  while (y * 12 + m <= end && out.length < 240) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) {
      m = 1;
      y++;
    }
  }
  return out;
}
const addMonths = (ym: string, k: number) => {
  const d = new Date(
    Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)) - 1 + k, 1),
  );
  return d.toISOString().slice(0, 7);
};
/** GSTR-2B for a month is generated on the 14th of the next month: the latest month that has one */
function latest2b(): string {
  const now = new Date(Date.now() + 5.5 * 3_600_000); // IST
  return addMonths(
    now.toISOString().slice(0, 7),
    now.getUTCDate() >= 14 ? -1 : -2,
  );
}
const fyLabel = (y: number) => `${y}-${String(y + 1).slice(2)}`;

type Range =
  "month" | "lastMonth" | "lastQuarter" | "fyToDate" | "fy" | "custom" | "all";
const RANGES: [Range, string][] = [
  ["lastMonth", "Last month"],
  ["lastQuarter", "Last quarter"],
  ["fyToDate", "This financial year to date"],
  ["fy", "A financial year"],
  ["month", "One month"],
  ["custom", "From – to"],
  ["all", "Everything (since July 2017)"],
];

function rangeMonths(
  r: Range,
  o: { month: string; fy: number; from: string; to: string },
): string[] {
  const last = latest2b();
  const clip = (xs: string[]) => xs.filter((x) => x <= last);
  switch (r) {
    case "month":
      return clip([o.month]);
    case "lastMonth":
      return [last];
    case "lastQuarter": {
      // the last GST quarter (Apr–Jun, Jul–Sep, Oct–Dec, Jan–Mar) whose GSTR-2B are all out
      const m = Number(last.slice(5, 7));
      const endM = m % 3 === 0 ? m : m - (m % 3);
      const end =
        endM === 0
          ? `${Number(last.slice(0, 4)) - 1}-12`
          : `${last.slice(0, 4)}-${String(endM).padStart(2, "0")}`;
      return monthsBetween(addMonths(end, -2), end);
    }
    case "fyToDate":
      return clip(monthsBetween(`${fyStart()}-04`, `${fyStart() + 1}-03`));
    case "fy":
      return clip(monthsBetween(`${o.fy}-04`, `${o.fy + 1}-03`));
    case "custom":
      return o.from && o.to && o.from <= o.to
        ? clip(monthsBetween(o.from, o.to))
        : [];
    case "all":
      return monthsBetween("2017-07", last);
  }
}

function Gstr2bPanel({ conn }: { conn: Json }) {
  const qc = useQueryClient();
  const toast = useToast();
  const live = conn.status === "active";
  const { data: saved } = useQuery({
    queryKey: ["gst", "gstr2b-saved", conn.id],
    queryFn: () =>
      get<Json[]>(`/api/v1/gst/connections/${conn.id}/gstr2b/saved`),
  });
  const [range, setRange] = useState<Range>("lastMonth");
  const [month, setMonth] = useState(latest2b());
  const [fy, setFy] = useState(fyStart() - 1);
  const [from, setFrom] = useState(`${fyStart()}-04`);
  const [to, setTo] = useState(latest2b());
  const [run, setRun] = useState<{
    done: number;
    total: number;
    stop: boolean;
  } | null>(null);
  const [results, setResults] = useState<Json[]>([]);
  const stopRef = useRef({ stop: false }).current;
  const [openMonth, setOpenMonth] = useState<string | null>(null);

  const months = rangeMonths(range, { month, fy, from, to });
  const savedSet = new Set((saved ?? []).map((x) => x.period));
  const unsaved = months.filter((m) => !savedSet.has(toPeriod(m)));
  const fys: number[] = [];
  for (let y = fyStart(); y >= 2017; y--) fys.push(y);

  const go = async (refresh: boolean) => {
    const list = months;
    const paid = refresh ? list.length : unsaved.length;
    if (
      paid > 3 &&
      !window.confirm(
        `This fetches ${paid} month(s) from the portal, at least one API credit each. Go ahead?`,
      )
    )
      return;
    stopRef.stop = false;
    setResults([]);
    setRun({ done: 0, total: list.length, stop: false });
    const out: Json[] = [];
    for (const [i, ym] of list.entries()) {
      if (stopRef.stop) break;
      const period = toPeriod(ym);
      try {
        const r = await post<Json>(
          `/api/v1/gst/connections/${conn.id}/gstr2b`,
          { period, refresh },
        );
        out.push({ period, ok: true, ...r });
      } catch (e) {
        const msg = (e as Error).message;
        out.push({ period, ok: false, error: msg });
        // the session ended or credits ran out: the rest would fail the same way
        if (/session|connect|otp|credit|402|expired/i.test(msg)) {
          toast(msg, true);
          break;
        }
      }
      setResults([...out]);
      setRun({ done: i + 1, total: list.length, stop: false });
    }
    setRun(null);
    qc.invalidateQueries({ queryKey: ["gst"] });
    qc.invalidateQueries({ queryKey: ["books"] });
    const ok = out.filter((x) => x.ok).length;
    toast(
      `GSTR-2B: ${ok} of ${list.length} month(s) matched against your bills`,
      ok < out.length,
    );
  };

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>GSTR-2B → purchase reconciliation</h2>
      </div>
      <div className="panel-body stack">
        <div
          className="row"
          style={{ gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}
        >
          <label className="field">
            Period
            <select
              value={range}
              onChange={(e) => setRange(e.target.value as Range)}
            >
              {RANGES.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          {range === "month" && (
            <label className="field">
              Month
              <input
                type="month"
                value={month}
                max={latest2b()}
                onChange={(e) => setMonth(e.target.value)}
              />
            </label>
          )}
          {range === "fy" && (
            <label className="field">
              Financial year
              <select
                value={fy}
                onChange={(e) => setFy(Number(e.target.value))}
              >
                {fys.map((y) => (
                  <option key={y} value={y}>
                    FY {fyLabel(y)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {range === "custom" && (
            <>
              <label className="field">
                From
                <input
                  type="month"
                  value={from}
                  min="2017-07"
                  max={latest2b()}
                  onChange={(e) => setFrom(e.target.value)}
                />
              </label>
              <label className="field">
                To
                <input
                  type="month"
                  value={to}
                  min="2017-07"
                  max={latest2b()}
                  onChange={(e) => setTo(e.target.value)}
                />
              </label>
            </>
          )}
          <button
            className="btn primary"
            disabled={!!run || !months.length || (!live && unsaved.length > 0)}
            onClick={() => go(false)}
          >
            Fetch & match
          </button>
          <button
            className="btn ghost"
            disabled={!!run || !months.length || !live}
            title="Fetches every month in the range again from the portal (uses credits)"
            onClick={() => go(true)}
          >
            Refresh from the portal
          </button>
          {run && (
            <button className="btn ghost" onClick={() => (stopRef.stop = true)}>
              Stop
            </button>
          )}
        </div>
        <div className="muted small">
          {months.length ? (
            <>
              {months.length === 1
                ? periodLabel(toPeriod(months[0]!))
                : `${periodLabel(toPeriod(months[0]!))} – ${periodLabel(toPeriod(months[months.length - 1]!))}`}{" "}
              · {months.length} month(s): {months.length - unsaved.length}{" "}
              already saved (no charge), {unsaved.length} to fetch from the
              portal (about one credit each).
            </>
          ) : (
            "No GSTR-2B in that range yet — it is generated on the 14th of the following month."
          )}{" "}
          Results go to Books → GST & TDS → GSTR-2B.
        </div>
        {run && (
          <div>
            <div className="muted small">
              Working… {run.done} of {run.total}
            </div>
            <div
              style={{
                height: 6,
                background: "var(--surface-2, #eef0f3)",
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  height: 6,
                  width: `${(100 * run.done) / Math.max(run.total, 1)}%`,
                  background: "var(--accent, #2563eb)",
                  borderRadius: 4,
                }}
              />
            </div>
          </div>
        )}
        {results.length > 0 && (
          <Gstr2bTable
            rows={results.map((r) => ({
              period: r.period,
              error: r.error,
              source: r.ok ? (r.cached ? "Saved copy" : "Portal") : null,
              fetchedAt: r.fetchedAt,
              lines: r.lines,
              matched: r.matched,
              mismatch: r.mismatch,
              unmatched: r.unmatched,
            }))}
            title="This run"
            onOpen={setOpenMonth}
          />
        )}
        {saved && saved.length > 0 && (
          <details open={results.length === 0}>
            <summary>
              All saved GSTR-2B ({saved.length} month(s)) — click a month for
              its documents
            </summary>
            <Gstr2bTable
              rows={saved.map((x) => ({
                period: x.period,
                fetchedAt: x.fetchedAt,
                files: x.files,
                lines: x.match?.lines,
                matched: x.match?.matched,
                mismatch: x.match?.mismatch,
                unmatched: x.match?.unmatched,
              }))}
              onOpen={setOpenMonth}
            />
          </details>
        )}
      </div>
      {openMonth && (
        <Gstr2bMonth
          conn={conn}
          period={openMonth}
          onClose={() => setOpenMonth(null)}
        />
      )}
    </section>
  );
}

const MATCH: Record<string, [string, string]> = {
  matched: ["Matched", "good"],
  mismatch: ["Differences", "warn"],
  unmatched: ["Not in your books", "bad"],
};
const SECTION_LABEL: Record<string, string> = {
  b2b: "B2B invoices",
  b2ba: "B2B amendments",
  cdnr: "Credit / debit notes",
  cdnra: "Note amendments",
  isd: "ISD credits",
  isda: "ISD amendments",
  impg: "Import of goods",
  impgsez: "Imports from SEZ",
  ecom: "E-commerce",
  ecoma: "E-commerce amendments",
};

function csv(rows: (string | number | null | undefined)[][]) {
  return rows
    .map((r) =>
      r
        .map((v) => {
          const t = v == null ? "" : String(v);
          return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
        })
        .join(","),
    )
    .join("\n");
}
function saveText(text: string, name: string, type: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** One GSTR-2B month: every supplier document, its match against your bills, and the bills suppliers did not report. */
function Gstr2bMonth({
  conn,
  period,
  onClose,
}: {
  conn: Json;
  period: string;
  onClose: () => void;
}) {
  const toast = useToast();
  const { data, error } = useQuery({
    queryKey: ["gst", "gstr2b-month", conn.id, period],
    queryFn: () =>
      get<Json>(`/api/v1/gst/connections/${conn.id}/gstr2b/${period}`),
  });
  const [tab, setTab] = useState<
    "all" | "matched" | "mismatch" | "unmatched" | "missing"
  >("all");
  const [q, setQ] = useState("");
  const qc = useQueryClient();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState<string[] | null>(null);
  const [linking, setLinking] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const lines: Json[] = data?.lines ?? [];
  const missing: Json[] = data?.missingInGstr2b ?? [];
  const refresh = () => {
    qc.invalidateQueries({
      queryKey: ["gst", "gstr2b-month", conn.id, period],
    });
    qc.invalidateQueries({ queryKey: ["gst", "gstr2b-saved", conn.id] });
    qc.invalidateQueries({ queryKey: ["books"] });
  };
  const run = async (fn: () => Promise<Json>, ok: (r: Json) => string) => {
    setBusy(true);
    try {
      const r = await fn();
      toast(ok(r));
      refresh();
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    } finally {
      setBusy(false);
    }
  };
  const syncBooks = () =>
    run(
      () => post<Json>(`/api/v1/books/gstr-2b/${period}/rematch`),
      (r) =>
        `Matched again: ${r.matched} matched, ${r.mismatch} with differences, ${r.unmatched} not in your books`,
    );
  const unlink = (l: Json) =>
    run(
      () => del<Json>(`/api/v1/books/gstr-2b/lines/${l.id}/link`),
      () => "Link removed",
    );
  const addable = (l: Json) =>
    l.match_status === "unmatched" &&
    l.bill_status !== "draft" &&
    !["credit_note", "debit_note"].includes(l.doc_type) &&
    Number(l.taxable) >= 0;
  const toggle = (id: string) =>
    setSel((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  const count = (k: string) => lines.filter((l) => l.match_status === k).length;
  const needle = q.trim().toLowerCase();
  const hit = (...xs: unknown[]) =>
    !needle ||
    xs.some((x) =>
      String(x ?? "")
        .toLowerCase()
        .includes(needle),
    );
  const shown = lines.filter(
    (l) =>
      (tab === "all" || l.match_status === tab) &&
      hit(l.supplier_gstin, l.supplier_name, l.doc_number, l.bill_number),
  );
  const shownMissing = missing.filter((b) =>
    hit(b.vendor_gstin, b.vendor, b.vendor_ref, b.bill_number),
  );
  const sum = (xs: Json[], k: string) =>
    xs.reduce((n, x) => n + Number(x[k] ?? 0), 0);
  const itcOk = lines.filter((l) => l.itc_available !== false);
  const downloadCsv = () =>
    saveText(
      csv([
        [
          "Supplier GSTIN",
          "Supplier",
          "Document",
          "Date",
          "Taxable",
          "Tax",
          "ITC available",
          "Status",
          "Note",
          "Bill",
        ],
        ...lines.map((l) => [
          l.supplier_gstin,
          l.supplier_name,
          l.doc_number,
          l.doc_date,
          l.taxable,
          l.tax,
          l.itc_available === false ? "N" : "Y",
          MATCH[l.match_status]?.[0] ?? l.match_status,
          l.note,
          l.bill_number,
        ]),
        ...missing.map((b) => [
          b.vendor_gstin,
          b.vendor,
          b.vendor_ref,
          b.bill_date,
          b.taxable,
          b.tax,
          "",
          "Not reported by supplier",
          "",
          b.bill_number,
        ]),
      ]),
      `GSTR-2B-${period}-${conn.gstin}.csv`,
      "text/csv",
    );
  const downloadRaw = async () => {
    try {
      const r = await get<Json>(
        `/api/v1/gst/connections/${conn.id}/gstr2b/${period}?raw=1`,
      );
      saveJson(
        r.raw?.length === 1 ? r.raw[0] : r.raw,
        `GSTR-2B-${period}-${conn.gstin}-portal.json`,
      );
    } catch (e) {
      toast((e as Error).message, true);
    }
  };
  const tabs: [typeof tab, string, number][] = [
    ["all", "All", lines.length],
    ["matched", "Matched", count("matched")],
    ["mismatch", "Differences", count("mismatch")],
    ["unmatched", "Not in your books", count("unmatched")],
    ["missing", "Bills the supplier didn't report", missing.length],
  ];
  return (
    <Modal
      title={`GSTR-2B · ${periodLabel(period)}`}
      onClose={onClose}
      wide
      footer={
        data && (
          <>
            <button className="btn" onClick={downloadCsv}>
              Download CSV
            </button>
            {data.files > 0 && (
              <button className="btn" onClick={downloadRaw}>
                Portal JSON
              </button>
            )}
          </>
        )
      }
    >
      <div className="modal-body stack">
        {error ? (
          <div className="muted">{(error as Error).message}</div>
        ) : !data ? (
          <Spinner />
        ) : (
          <div className="stack">
            <div className="muted small">
              {data.fetchedAt
                ? `Fetched ${dateTime(data.fetchedAt)}`
                : "Imported from a JSON file"}
              {data.generatedOn
                ? ` · generated on the portal ${data.generatedOn}`
                : ""}
              {data.importedAt ? ` · matched ${dateTime(data.importedAt)}` : ""}
              {" · "}ITC available {money2(sum(itcOk, "tax"))} on taxable{" "}
              {money2(sum(itcOk, "taxable"))}
            </div>
            {Object.keys(data.sections ?? {}).length > 0 && (
              <div className="row small" style={{ gap: 6, flexWrap: "wrap" }}>
                {Object.entries(data.sections as Record<string, number>).map(
                  ([k, v]) => (
                    <span key={k} className="chip">
                      {SECTION_LABEL[k] ?? k.toUpperCase()}: {v}
                    </span>
                  ),
                )}
              </div>
            )}
            <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
              {tabs.map(([k, l, n]) => (
                <button
                  key={k}
                  className={`btn sm ${tab === k ? "primary" : ""}`}
                  onClick={() => setTab(k)}
                >
                  {l} ({n})
                </button>
              ))}
              <input
                placeholder="Search supplier, GSTIN, invoice…"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                style={{ marginLeft: "auto", minWidth: 220 }}
              />
            </div>
            <div
              className="row"
              style={{ gap: 8, flexWrap: "wrap", alignItems: "center" }}
            >
              <button
                className="btn sm"
                disabled={busy}
                title="Match this month against your bills again — picks up bills entered or corrected since (free)"
                onClick={syncBooks}
              >
                Sync with books
              </button>
              {count("unmatched") > 0 && (
                <>
                  <button
                    className="btn sm primary"
                    disabled={busy || !sel.size}
                    onClick={() => setAdding([...sel])}
                  >
                    Add selected to books{sel.size ? ` (${sel.size})` : ""}
                  </button>
                  <button
                    className="btn sm ghost"
                    disabled={busy}
                    onClick={() =>
                      setSel(new Set(lines.filter(addable).map((l) => l.id)))
                    }
                  >
                    Select all not in books
                  </button>
                  {sel.size > 0 && (
                    <button
                      className="btn sm ghost"
                      onClick={() => setSel(new Set())}
                    >
                      Clear
                    </button>
                  )}
                </>
              )}
            </div>
            <div
              className="table-wrap"
              style={{ maxHeight: 460, overflow: "auto" }}
            >
              {tab === "missing" ? (
                <table className="data">
                  <thead>
                    <tr>
                      <th>Supplier</th>
                      <th>Their invoice</th>
                      <th>Date</th>
                      <th style={{ textAlign: "right" }}>Taxable</th>
                      <th style={{ textAlign: "right" }}>Tax</th>
                      <th>Bill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownMissing.map((b) => (
                      <tr key={b.id}>
                        <td>
                          {b.vendor}
                          <div className="muted small">{b.vendor_gstin}</div>
                        </td>
                        <td>{b.vendor_ref ?? "—"}</td>
                        <td>{date(b.bill_date)}</td>
                        <td style={{ textAlign: "right" }}>
                          {money2(b.taxable)}
                        </td>
                        <td style={{ textAlign: "right" }}>{money2(b.tax)}</td>
                        <td>
                          <Link to={`/o/bill/${b.id}`}>{b.bill_number}</Link>
                        </td>
                      </tr>
                    ))}
                    {!shownMissing.length && (
                      <tr>
                        <td
                          colSpan={6}
                          className="muted"
                          style={{ textAlign: "center", padding: 16 }}
                        >
                          Every eligible bill of this month was reported by its
                          supplier.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              ) : (
                <table className="data">
                  <thead>
                    <tr>
                      <th style={{ width: 28 }}>
                        <SelectAll
                          ids={shown.filter(addable).map((l) => l.id)}
                          sel={sel}
                          setSel={setSel}
                        />
                      </th>
                      <th>Supplier</th>
                      <th>Document</th>
                      <th>Date</th>
                      <th style={{ textAlign: "right" }}>Taxable</th>
                      <th style={{ textAlign: "right" }}>Tax</th>
                      <th>ITC</th>
                      <th>Status</th>
                      <th>Your bill</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shown.map((l) => (
                      <tr key={l.id}>
                        <td>
                          {addable(l) && (
                            <input
                              type="checkbox"
                              checked={sel.has(l.id)}
                              onChange={() => toggle(l.id)}
                              aria-label={`Select ${l.doc_number}`}
                            />
                          )}
                        </td>
                        <td>
                          {l.supplier_name ?? "—"}
                          <div className="muted small">{l.supplier_gstin}</div>
                        </td>
                        <td>{l.doc_number}</td>
                        <td>{l.doc_date ? date(l.doc_date) : ""}</td>
                        <td style={{ textAlign: "right" }}>
                          {money2(l.taxable)}
                        </td>
                        <td style={{ textAlign: "right" }}>{money2(l.tax)}</td>
                        <td className="small">
                          {l.itc_available === false ? "Not available" : "Yes"}
                        </td>
                        <td>
                          <span
                            className={`chip ${MATCH[l.match_status]?.[1] ?? ""}`}
                          >
                            {MATCH[l.match_status]?.[0] ?? l.match_status}
                          </span>
                          {l.note && (
                            <div className="muted small">{l.note}</div>
                          )}
                        </td>
                        <td>
                          {l.bill_id && (
                            <div>
                              <Link to={`/o/bill/${l.bill_id}`}>
                                {l.bill_number ?? "Draft bill"}
                              </Link>
                              {l.bill_status === "draft" && (
                                <span
                                  className="chip warn"
                                  style={{ marginLeft: 6 }}
                                >
                                  Draft
                                </span>
                              )}
                            </div>
                          )}
                          <div className="row" style={{ gap: 4, marginTop: 2 }}>
                            {addable(l) && (
                              <button
                                className="btn sm"
                                disabled={busy}
                                onClick={() => setAdding([l.id])}
                              >
                                Add to books
                              </button>
                            )}
                            {l.match_status !== "matched" &&
                              l.bill_status !== "draft" && (
                                <button
                                  className="btn sm ghost"
                                  disabled={busy}
                                  title="Match it to a bill already in your books (when its number was typed differently)"
                                  onClick={() => setLinking(l)}
                                >
                                  Link to a bill
                                </button>
                              )}
                            {/Linked by hand/.test(l.note ?? "") && (
                              <button
                                className="btn sm ghost"
                                disabled={busy}
                                onClick={() => unlink(l)}
                              >
                                Unlink
                              </button>
                            )}
                            {["credit_note", "debit_note"].includes(
                              l.doc_type,
                            ) &&
                              l.match_status === "unmatched" && (
                                <span className="muted small">
                                  Enter as a vendor credit on the bill
                                </span>
                              )}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!shown.length && (
                      <tr>
                        <td
                          colSpan={9}
                          className="muted"
                          style={{ textAlign: "center", padding: 16 }}
                        >
                          {lines.length
                            ? "Nothing matches the filter."
                            : "No supplier documents in this month's GSTR-2B."}
                        </td>
                      </tr>
                    )}
                  </tbody>
                  {shown.length > 1 && (
                    <tfoot>
                      <tr>
                        <td colSpan={4}>
                          <b>{shown.length} document(s)</b>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <b>{money2(sum(shown, "taxable"))}</b>
                        </td>
                        <td style={{ textAlign: "right" }}>
                          <b>{money2(sum(shown, "tax"))}</b>
                        </td>
                        <td colSpan={3} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              )}
            </div>
            {data.itcSummary && (
              <details>
                <summary>The portal's ITC summary</summary>
                <JsonBox value={data.itcSummary} />
              </details>
            )}
          </div>
        )}
        {adding && (
          <AddToBooks
            lines={lines.filter((l) => adding.includes(l.id))}
            onClose={() => setAdding(null)}
            onDone={() => {
              setAdding(null);
              setSel(new Set());
              refresh();
            }}
          />
        )}
        {linking && (
          <LinkBill
            line={linking}
            onClose={() => setLinking(null)}
            onDone={() => {
              setLinking(null);
              refresh();
            }}
          />
        )}
      </div>
    </Modal>
  );
}

/** Enters GSTR-2B invoices that are missing from the books as bills (and the supplier when new). */
function AddToBooks({
  lines,
  onClose,
  onDone,
}: {
  lines: Json[];
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data: accounts } = useQuery({
    queryKey: ["books", "accounts"],
    queryFn: () => get<Json[]>("/api/v1/books/accounts"),
    staleTime: 30_000,
  });
  const usable = (accounts ?? []).filter(
    (a) =>
      a.is_active !== false &&
      (a.type === "expense" ||
        (a.type === "asset" &&
          ![
            "accounts_receivable",
            "bank",
            "cash",
            "credit_card",
            "tax_payable",
          ].includes(a.subtype))),
  );
  const [accountId, setAccountId] = useState("");
  const [postIt, setPostIt] = useState(true);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Json | null>(null);
  const go = async () => {
    setBusy(true);
    try {
      const r = await post<Json>("/api/v1/books/gstr-2b/add-to-books", {
        lineIds: lines.map((l) => l.id),
        accountId: accountId || null,
        post: postIt,
      });
      setResult(r);
      toast(
        `${r.added} bill(s) entered${r.posted ? `, ${r.posted} posted` : ""}${r.vendorsCreated ? `, ${r.vendorsCreated} new supplier(s)` : ""}`,
        r.added < lines.length,
      );
      if (r.added === lines.length) onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  const total = (k: string) => lines.reduce((n, l) => n + Number(l[k] ?? 0), 0);
  return (
    <Modal
      title={`Add ${lines.length} document(s) to the books`}
      onClose={result ? onDone : onClose}
      footer={
        result ? (
          <button className="btn primary" onClick={onDone}>
            Done
          </button>
        ) : (
          <>
            <button className="btn ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn primary" disabled={busy} onClick={go}>
              {busy
                ? "Entering…"
                : postIt
                  ? "Enter and post bills"
                  : "Enter as draft bills"}
            </button>
          </>
        )
      }
    >
      <div className="modal-body stack">
        {!result ? (
          <div className="stack">
            <div className="muted small">
              Each document becomes a bill with the supplier's invoice number
              and date, and one line for the taxable value (
              {money2(total("taxable"))} in all) at the GST rate it implies (tax{" "}
              {money2(total("tax"))}). A supplier not yet in SanchalanOS is added
              from its GSTIN.
            </div>
            <label className="field">
              Book the purchase to
              <select
                value={accountId}
                onChange={(e) => setAccountId(e.target.value)}
              >
                <option value="">Purchases (default)</option>
                {usable.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.code ? `${a.code} · ` : ""}
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="row" style={{ gap: 8 }}>
              <input
                type="checkbox"
                checked={postIt}
                onChange={(e) => setPostIt(e.target.checked)}
              />
              Post the bills now (they then match GSTR-2B and count for ITC).
              Leave unticked to review them as drafts first.
            </label>
            <div
              className="table-wrap"
              style={{ maxHeight: 240, overflow: "auto" }}
            >
              <table className="data">
                <tbody>
                  {lines.map((l) => (
                    <tr key={l.id}>
                      <td>
                        {l.supplier_name ?? l.supplier_gstin}
                        <div className="muted small">{l.supplier_gstin}</div>
                      </td>
                      <td>{l.doc_number}</td>
                      <td>{l.doc_date ? date(l.doc_date) : ""}</td>
                      <td style={{ textAlign: "right" }}>
                        {money2(l.taxable)}
                      </td>
                      <td style={{ textAlign: "right" }}>{money2(l.tax)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <tbody>
                {(result.results as Json[]).map((r) => {
                  const l = lines.find((x) => x.id === r.lineId);
                  return (
                    <tr key={r.lineId}>
                      <td>{l?.doc_number}</td>
                      <td className="small">
                        {r.ok ? (
                          <>
                            <Link to={`/o/bill/${r.billId}`}>
                              {r.billNumber ?? "Draft bill"}
                            </Link>{" "}
                            · {r.status === "open" ? "posted" : r.status}
                            {r.vendorCreated ? " · new supplier" : ""}
                          </>
                        ) : (
                          <span style={{ color: "var(--bad)" }}>{r.error}</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </Modal>
  );
}

/** Matches a GSTR-2B document to a bill already in the books, for when the number was typed differently. */
function LinkBill({
  line,
  onClose,
  onDone,
}: {
  line: Json;
  onClose: () => void;
  onDone: () => void;
}) {
  const toast = useToast();
  const { data, error } = useQuery({
    queryKey: ["gst", "gstr2b-candidates", line.id],
    queryFn: () =>
      get<Json>(`/api/v1/books/gstr-2b/lines/${line.id}/candidates`),
  });
  const [busy, setBusy] = useState(false);
  const link = async (billId: string) => {
    setBusy(true);
    try {
      const r = await post<Json>(
        `/api/v1/books/gstr-2b/lines/${line.id}/link`,
        { billId },
      );
      toast(
        `Linked — ${r.matched} matched, ${r.mismatch} with differences this month`,
      );
      onDone();
    } catch (e) {
      toast((e as Error).message, true);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal title={`Link ${line.doc_number} to a bill`} onClose={onClose} wide>
      <div className="modal-body stack">
        <div className="stack">
          <div className="muted small">
            {line.supplier_name ?? ""} {line.supplier_gstin} · taxable{" "}
            {money2(line.taxable)} · tax {money2(line.tax)}. Posted bills from
            this supplier within six months, closest amount first. The link is
            kept when the month is fetched again.
          </div>
          {error ? (
            <div className="muted">{(error as Error).message}</div>
          ) : !data ? (
            <Spinner />
          ) : !data.bills.length ? (
            <Empty title="No posted bill from this supplier around that date">
              Enter it with <b>Add to books</b> instead, or post the bill first
              if it is still a draft.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Bill</th>
                    <th>Their number</th>
                    <th>Date</th>
                    <th style={{ textAlign: "right" }}>Taxable</th>
                    <th style={{ textAlign: "right" }}>Tax</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {(data.bills as Json[]).map((b) => (
                    <tr key={b.id}>
                      <td>
                        <Link to={`/o/bill/${b.id}`}>{b.bill_number}</Link>
                        {b.sameAmount && (
                          <span className="chip good" style={{ marginLeft: 6 }}>
                            Same amount
                          </span>
                        )}
                      </td>
                      <td>{b.vendor_ref ?? "—"}</td>
                      <td>{date(b.bill_date)}</td>
                      <td style={{ textAlign: "right" }}>
                        {money2(b.taxable)}
                      </td>
                      <td style={{ textAlign: "right" }}>{money2(b.tax)}</td>
                      <td>
                        <button
                          className="btn sm primary"
                          disabled={busy}
                          onClick={() => link(b.id)}
                        >
                          Link
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

function Gstr2bTable({
  rows,
  title,
  onOpen,
}: {
  rows: Json[];
  title?: string;
  onOpen?: (period: string) => void;
}) {
  const sum = (k: string) => rows.reduce((n, r) => n + Number(r[k] ?? 0), 0);
  return (
    <div className="table-wrap">
      {title && (
        <div className="muted small" style={{ margin: "4px 0" }}>
          {title}
        </div>
      )}
      <table className="data">
        <thead>
          <tr>
            <th>Month</th>
            <th>From</th>
            <th>Fetched</th>
            <th style={{ textAlign: "right" }}>Lines</th>
            <th style={{ textAlign: "right" }}>Matched</th>
            <th style={{ textAlign: "right" }}>Mismatch</th>
            <th style={{ textAlign: "right" }}>Not in books</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={r.period}
              className={r.error ? undefined : "clickable"}
              style={r.error ? undefined : { cursor: "pointer" }}
              title={r.error ? undefined : "Open this month's documents"}
              onClick={() => !r.error && onOpen?.(r.period)}
            >
              <td>{periodLabel(r.period)}</td>
              {r.error ? (
                <td
                  colSpan={7}
                  className="small"
                  style={{ color: "var(--bad)" }}
                >
                  {r.error}
                </td>
              ) : (
                <>
                  <td className="small">
                    {r.source ?? (r.files > 1 ? `${r.files} files` : "Saved")}
                  </td>
                  <td className="small">
                    {r.fetchedAt ? dateTime(r.fetchedAt) : ""}
                  </td>
                  <td style={{ textAlign: "right" }}>{r.lines ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.matched ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.mismatch ?? "—"}</td>
                  <td style={{ textAlign: "right" }}>{r.unmatched ?? "—"}</td>
                  <td>
                    {onOpen && (
                      <button
                        className="btn sm"
                        onClick={() => onOpen(r.period)}
                      >
                        View
                      </button>
                    )}
                  </td>
                </>
              )}
            </tr>
          ))}
          {rows.length > 1 && (
            <tr>
              <td>
                <b>Total</b>
              </td>
              <td colSpan={2} />
              <td style={{ textAlign: "right" }}>
                <b>{sum("lines")}</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{sum("matched")}</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{sum("mismatch")}</b>
              </td>
              <td style={{ textAlign: "right" }}>
                <b>{sum("unmatched")}</b>
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function PortalViews({ conn }: { conn: Json }) {
  const gsp = useGsp();
  const act = useAct([["gst"]]);
  const { data: views } = useQuery({
    queryKey: ["gst", "views"],
    queryFn: () => get<Json[]>("/api/v1/gst/views"),
    staleTime: Infinity,
  });
  const [kind, setKind] = useState("ledger_balance");
  const [params, setParams] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Json | null>(null);
  /** the saved copy when there is one; refresh = call the provider (paid) */
  const fetchIt = async (refresh: boolean) => {
    if (!v) return;
    const all = Object.fromEntries(
      [...v.params, ...v.optional]
        .map((p: string) => [p, params[p] ?? defaults(p)])
        .filter(([, x]) => x !== ""),
    );
    const r = await act(
      () =>
        post<Json>(
          `/api/v1/gst/connections/${conn.id}/views/${kind}${refresh ? "?refresh=1" : ""}`,
          all,
        ),
      refresh ? "Fetched fresh from the portal" : "Loaded",
    );
    if (r) setResult(r);
  };
  const [challan, setChallan] = useState(false);
  const live = conn.status === "active";
  const v = views?.find((x) => x.kind === kind);
  const defaults = (p: string): string => {
    if (p === "period") return toPeriod(ymPrev());
    if (p === "from") return `${fyStart()}-04-01`;
    if (p === "to") return new Date().toISOString().slice(0, 10);
    if (p === "returnType") return "R3B";
    if (p === "recType") return "TDS";
    if (p === "supplyType") return "B2B";
    return "";
  };
  return (
    <div className="stack">
      <section className="panel">
        <div className="panel-head">
          <h2>Look up on the portal</h2>
        </div>
        <div className="panel-body stack">
          <div
            className="row"
            style={{ flexWrap: "wrap", gap: 8, alignItems: "flex-end" }}
          >
            <label className="field">
              What
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value);
                  setParams({});
                  setResult(null);
                }}
              >
                {(views ?? []).map((x) => (
                  <option key={x.kind} value={x.kind}>
                    {x.label}
                  </option>
                ))}
              </select>
            </label>
            {v &&
              [...v.params, ...v.optional].map((p: string) => (
                <label key={p} className="field">
                  {p}
                  {v.dates.includes(p) ? (
                    <input
                      type="date"
                      value={params[p] ?? defaults(p)}
                      onChange={(e) =>
                        setParams({ ...params, [p]: e.target.value })
                      }
                    />
                  ) : (
                    <input
                      value={params[p] ?? defaults(p)}
                      onChange={(e) =>
                        setParams({ ...params, [p]: e.target.value })
                      }
                      style={{ width: 130 }}
                    />
                  )}
                </label>
              ))}
            <button
              className="btn primary"
              disabled={!v}
              onClick={() => fetchIt(false)}
            >
              Show
            </button>
          </div>
          <div className="muted small">
            Periods are MMYYYY (e.g. {toPeriod(ymPrev())}). Return types: R1,
            R3B, R9…
          </div>
          {result && (
            <>
              <div className="row" style={{ gap: 8 }}>
                <b>{result.label}</b>
                <span className="muted small">
                  {result.cached ? "Saved copy from " : "Fetched "}
                  {dateTime(result.fetchedAt)}
                </span>
                <button
                  className="btn sm"
                  disabled={!live}
                  title="Calls the GST provider again (may use credits)"
                  onClick={() => fetchIt(true)}
                >
                  Refresh from the portal
                </button>
                <button
                  className="btn sm ghost"
                  onClick={() =>
                    saveJson(result.data, `${conn.gstin}-${kind}.json`)
                  }
                >
                  Download
                </button>
              </div>
              <JsonBox value={result.data} height={420} />
            </>
          )}
        </div>
      </section>
      <Gstr2bPanel conn={conn} />
      {gsp.challan ? (
        <section className="panel">
          <div className="panel-head">
            <h2>Pay GST (challan)</h2>
            <button
              className="btn sm primary"
              disabled={!live}
              onClick={() => setChallan(true)}
            >
              Create challan
            </button>
          </div>
          <div className="panel-body muted small">
            Creates a PMT-06 challan on the portal. Pay it with the CPIN by net
            banking, NEFT / RTGS or over the counter; the money reaches your
            cash ledger.
          </div>
        </section>
      ) : (
        <section className="panel">
          <div className="panel-head">
            <h2>Pay GST (challan)</h2>
          </div>
          <div className="panel-body muted small">
            Create the challan on gst.gov.in: Services → Payments → Create
            Challan. Pay it, then use <b>Update cash & ITC balance</b> before
            offsetting GSTR-3B.
          </div>
        </section>
      )}
      {challan && (
        <ChallanModal conn={conn} onClose={() => setChallan(false)} />
      )}
    </div>
  );
}

function ChallanModal({ conn, onClose }: { conn: Json; onClose: () => void }) {
  const act = useAct([["gst"]]);
  const [f, setF] = useState<Json>({
    month: ymPrev(),
    mode: "NEFT",
    email: "",
    mobile: "",
    igst: "",
    cgst: "",
    sgst: "",
    cess: "",
    interest: "",
    fee: "",
  });
  const [done, setDone] = useState<Json | null>(null);
  const amt = (x: string) => Number(x || 0);
  const total = ["igst", "cgst", "sgst", "cess", "interest", "fee"].reduce(
    (s, k) => s + amt(f[k]),
    0,
  );
  return (
    <Modal
      title="Create GST challan"
      onClose={onClose}
      footer={
        !done && (
          <button
            className="btn primary"
            disabled={
              !(total > 0) || !f.email || !/^[6-9]\d{9}$/.test(f.mobile)
            }
            onClick={async () => {
              const half = (x: string) => Math.round((amt(x) / 2) * 100) / 100;
              const r = await act(
                () =>
                  post<Json>(`/api/v1/gst/connections/${conn.id}/challans`, {
                    period: toPeriod(f.month),
                    mode: f.mode,
                    email: f.email,
                    mobile: f.mobile,
                    amounts: {
                      igst: { tax: amt(f.igst) },
                      cgst: {
                        tax: amt(f.cgst),
                        interest: half(f.interest),
                        fee: half(f.fee),
                      },
                      sgst: {
                        tax: amt(f.sgst),
                        interest: amt(f.interest) - half(f.interest),
                        fee: amt(f.fee) - half(f.fee),
                      },
                      cess: { tax: amt(f.cess) },
                    },
                  }),
                "Challan created",
              );
              if (r) setDone(r);
            }}
          >
            Create · {money2(total)}
          </button>
        )
      }
    >
      {done ? (
        <div className="modal-body stack">
          <div>
            CPIN <b>{done.cpin ?? "—"}</b> for {money2(done.total)}
            {done.expiresOn ? `, valid until ${done.expiresOn}` : ""}.
          </div>
          <div className="muted small">
            Pay it before it expires; the payment then shows in the cash ledger.
          </div>
        </div>
      ) : (
        <div className="modal-body grid2">
          <label className="field">
            For the month
            <input
              type="month"
              value={f.month}
              onChange={(e) => setF({ ...f, month: e.target.value })}
            />
          </label>
          <label className="field">
            Pay by
            <select
              value={f.mode}
              onChange={(e) => setF({ ...f, mode: e.target.value })}
            >
              <option value="EPY">Net banking / card (e-payment)</option>
              <option value="NEFT">NEFT / RTGS</option>
              <option value="OTC">Over the counter</option>
              <option value="UPI">UPI</option>
            </select>
          </label>
          {(["igst", "cgst", "sgst", "cess"] as const).map((k) => (
            <label key={k} className="field">
              {k.toUpperCase()} (tax)
              <input
                type="number"
                min={0}
                value={f[k]}
                onChange={(e) => setF({ ...f, [k]: e.target.value })}
              />
            </label>
          ))}
          <label className="field">
            Interest (CGST + SGST)
            <input
              type="number"
              min={0}
              value={f.interest}
              onChange={(e) => setF({ ...f, interest: e.target.value })}
            />
          </label>
          <label className="field">
            Late fee (CGST + SGST)
            <input
              type="number"
              min={0}
              value={f.fee}
              onChange={(e) => setF({ ...f, fee: e.target.value })}
            />
          </label>
          <label className="field">
            Email
            <input
              type="email"
              value={f.email}
              onChange={(e) => setF({ ...f, email: e.target.value })}
            />
          </label>
          <label className="field">
            Mobile
            <input
              inputMode="numeric"
              value={f.mobile}
              onChange={(e) =>
                setF({
                  ...f,
                  mobile: e.target.value.replace(/\D/g, "").slice(0, 10),
                })
              }
            />
          </label>
        </div>
      )}
    </Modal>
  );
}

/* ───────────────────────── registration ───────────────────────── */

function RegistrationForm({
  conn,
  onDone,
  onCancel,
}: {
  conn?: Json;
  onDone: (id: string) => void;
  onCancel?: () => void;
}) {
  const act = useAct([["gst"]]);
  const [f, setF] = useState<Json>({
    gstin: conn?.gstin ?? "",
    legalName: conn?.legalName ?? "",
    gstUsername: conn?.gstUsername ?? "",
    signatoryPan: conn?.signatoryPan ?? "",
    filingFrequency: conn?.filingFrequency ?? "monthly",
    einvUsername: conn?.einvUsername ?? "",
    einvPassword: "",
    ewbUsername: conn?.ewbUsername ?? "",
    ewbPassword: "",
  });
  const [found, setFound] = useState<Json | null>(null);
  const set = (k: string) => (e: { target: { value: string } }) =>
    setF({ ...f, [k]: e.target.value });
  const lookup = async (refresh = false) => {
    const r = await act(
      () =>
        get<Json>(
          `/api/v1/gst/search/${f.gstin.trim().toUpperCase()}${refresh ? "?refresh=1" : ""}`,
        ),
      "Found on the GST portal",
    );
    if (r?.legalName) setF({ ...f, legalName: r.legalName });
    if (r) setFound(r);
  };
  const save = async () => {
    const body: Json = { ...f, gstin: f.gstin.trim().toUpperCase() };
    if (!body.einvPassword) delete body.einvPassword;
    if (!body.ewbPassword) delete body.ewbPassword;
    const r = conn
      ? await act(
          () => patch<Json>(`/api/v1/gst/connections/${conn.id}`, body),
          "Saved",
        )
      : await act(
          () => post<Json>("/api/v1/gst/connections", body),
          "GST registration added",
        );
    if (r?.id) onDone(r.id);
  };
  return (
    <div className="panel-body stack">
      <div className="grid2">
        <label className="field">
          GSTIN
          <div className="row" style={{ gap: 6 }}>
            <input
              value={f.gstin}
              onChange={(e) =>
                setF({ ...f, gstin: e.target.value.toUpperCase().slice(0, 15) })
              }
              placeholder="09AAACH1234M1Z5"
            />
            <button
              className="btn sm ghost"
              disabled={f.gstin.length !== 15}
              onClick={() => lookup(false)}
            >
              Look up
            </button>
          </div>
          {found && (
            <span className="muted small">
              {found.legalName} · {found.status ?? ""} ·{" "}
              {found.cached ? "saved copy from " : "fetched "}
              {dateTime(found.fetchedAt)}{" "}
              <button className="btn sm ghost" onClick={() => lookup(true)}>
                Refresh
              </button>
            </span>
          )}
        </label>
        <label className="field">
          Legal name
          <input value={f.legalName} onChange={set("legalName")} />
        </label>
        <label className="field">
          GST portal username
          <input
            value={f.gstUsername}
            onChange={set("gstUsername")}
            autoComplete="off"
          />
        </label>
        <label className="field">
          Authorised signatory's PAN (for EVC)
          <input
            value={f.signatoryPan}
            onChange={(e) =>
              setF({
                ...f,
                signatoryPan: e.target.value.toUpperCase().slice(0, 10),
              })
            }
          />
        </label>
        <label className="field">
          Files GSTR-1 / 3B
          <select value={f.filingFrequency} onChange={set("filingFrequency")}>
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly (QRMP)</option>
          </select>
        </label>
        <div />
        <div className="wide muted small">
          <b>E-invoice and e-way bill (optional).</b> Create API users on
          einvoice1.gst.gov.in and ewaybillgst.gov.in (API Registration →
          Through GSP → WhiteBooks) and enter them here. Passwords are stored
          encrypted and never shown again.
        </div>
        <label className="field">
          E-invoice API username
          <input
            value={f.einvUsername}
            onChange={set("einvUsername")}
            autoComplete="off"
          />
        </label>
        <label className="field">
          E-invoice API password{" "}
          {conn?.hasEinvPassword && (
            <span className="muted small">(saved — leave blank to keep)</span>
          )}
          <input
            type="password"
            value={f.einvPassword}
            onChange={set("einvPassword")}
            autoComplete="new-password"
          />
        </label>
        <label className="field">
          E-way bill API username
          <input
            value={f.ewbUsername}
            onChange={set("ewbUsername")}
            autoComplete="off"
          />
        </label>
        <label className="field">
          E-way bill API password{" "}
          {conn?.hasEwbPassword && (
            <span className="muted small">(saved — leave blank to keep)</span>
          )}
          <input
            type="password"
            value={f.ewbPassword}
            onChange={set("ewbPassword")}
            autoComplete="new-password"
          />
        </label>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          className="btn primary"
          disabled={f.gstin.length !== 15}
          onClick={save}
        >
          {conn ? "Save" : "Add registration"}
        </button>
        {onCancel && (
          <button className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
        )}
        {conn && (
          <button
            className="btn ghost danger"
            style={{ marginLeft: "auto" }}
            onClick={() =>
              window.confirm(
                `Remove ${conn.gstin} from SanchalanOS? Prepared returns for it are deleted too.`,
              ) &&
              act(() => del(`/api/v1/gst/connections/${conn.id}`), "Removed")
            }
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}

function ActivityLog({ conn }: { conn: Json }) {
  const { data } = useQuery({
    queryKey: ["gst", "log", conn.id],
    queryFn: () => get<Json[]>(`/api/v1/gst/connections/${conn.id}/log`),
  });
  if (!data) return <Spinner />;
  return (
    <div className="table-wrap">
      <table className="data small">
        <thead>
          <tr>
            <th>When</th>
            <th>What</th>
            <th />
            <th>Detail</th>
            <th>By</th>
          </tr>
        </thead>
        <tbody>
          {data.map((e, i) => (
            <tr key={i}>
              <td>{dateTime(e.created_at)}</td>
              <td>{e.action}</td>
              <td>
                {e.ok ? "✓" : <span style={{ color: "var(--bad)" }}>✗</span>}
              </td>
              <td>{e.message ?? ""}</td>
              <td>{e.by ?? ""}</td>
            </tr>
          ))}
          {!data.length && (
            <tr>
              <td colSpan={5} className="muted">
                Nothing yet.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

/* ───────────────────────── invoice panel: IRN and e-way bill ───────────────────────── */

export function InvoiceGst({
  invoiceId,
  canAct,
}: {
  invoiceId: string;
  canAct: boolean;
}) {
  const act = useAct([
    ["gst", "invoice", invoiceId],
    ["invoice", invoiceId],
  ]);
  const { data } = useQuery({
    queryKey: ["gst", "invoice", invoiceId],
    queryFn: () => get<Json>(`/api/v1/gst/invoices/${invoiceId}`),
    retry: false,
  });
  const [modal, setModal] = useState<
    null | "ewb" | "cancel-irn" | "cancel-ewb" | "vehicle"
  >(null);
  const [f, setF] = useState<Json>({});
  if (!data) return null;
  const irnLive = data.irn && !data.irnCancelledAt;
  const ewbLive = data.ewbNo && !data.ewbCancelledAt;
  return (
    <div className="panel" style={{ padding: 12 }}>
      <div
        className="row"
        style={{ flexWrap: "wrap", gap: 10, alignItems: "center" }}
      >
        <b>E-invoice & e-way bill</b>
        {irnLive ? (
          <span className="chip good" title={data.irn}>
            IRN {String(data.irn).slice(0, 10)}… · ack {data.ackNo}
          </span>
        ) : data.irnCancelledAt ? (
          <span className="chip bad">IRN cancelled</span>
        ) : (
          <span className="chip">No IRN</span>
        )}
        {ewbLive ? (
          <span className="chip good">
            EWB {data.ewbNo}
            {data.ewbValidUntil
              ? ` · valid till ${dateTime(data.ewbValidUntil)}`
              : ""}
          </span>
        ) : data.ewbCancelledAt ? (
          <span className="chip bad">E-way bill cancelled</span>
        ) : null}
        {!data.connected && (
          <span className="muted small">
            Add this GSTIN under Billing → GST portal to generate the IRN and
            e-way bill here.
          </span>
        )}
        {data.connected && canAct && (
          <span
            className="row"
            style={{ gap: 6, marginLeft: "auto", flexWrap: "wrap" }}
          >
            {!irnLive && (
              <button
                className="btn sm primary"
                disabled={!data.einvoiceReady}
                title={
                  data.einvoiceReady
                    ? undefined
                    : "Add the e-invoice API user on the GST registration"
                }
                onClick={() =>
                  act(
                    () => post(`/api/v1/gst/invoices/${invoiceId}/irn`),
                    "IRN generated",
                  )
                }
              >
                Generate IRN
              </button>
            )}
            {!ewbLive && (
              <button
                className="btn sm"
                disabled={!irnLive && !data.ewayBillReady}
                onClick={() => {
                  setF({
                    distance: "0",
                    mode: "road",
                    vehicleNo: "",
                    transporterId: "",
                    transporterName: "",
                    docNo: "",
                    docDate: "",
                  });
                  setModal("ewb");
                }}
              >
                E-way bill
              </button>
            )}
            {ewbLive && (
              <button
                className="btn sm"
                onClick={() => {
                  setF({
                    vehicleNo: "",
                    fromPlace: "",
                    reason: "first_time",
                    remark: "",
                  });
                  setModal("vehicle");
                }}
              >
                Update vehicle
              </button>
            )}
            {ewbLive && (
              <button
                className="btn sm ghost danger"
                onClick={() => {
                  setF({ reason: "data_entry_mistake", remark: "" });
                  setModal("cancel-ewb");
                }}
              >
                Cancel EWB
              </button>
            )}
            {irnLive && (
              <button
                className="btn sm ghost danger"
                onClick={() => {
                  setF({ reason: "data_entry_mistake", remark: "" });
                  setModal("cancel-irn");
                }}
              >
                Cancel IRN
              </button>
            )}
          </span>
        )}
      </div>
      {irnLive && data.qr && (
        <div className="muted small" style={{ marginTop: 6 }}>
          The signed QR code is printed on the invoice.
        </div>
      )}
      {modal === "ewb" && (
        <Modal
          title="Generate e-way bill"
          onClose={() => setModal(null)}
          footer={
            <button
              className="btn primary"
              onClick={async () =>
                (await act(
                  () =>
                    post(`/api/v1/gst/invoices/${invoiceId}/eway-bill`, {
                      distance: Number(f.distance || 0),
                      mode: f.mode,
                      vehicleNo: f.vehicleNo || null,
                      transporterId: f.transporterId || null,
                      transporterName: f.transporterName || null,
                      docNo: f.docNo || null,
                      docDate: f.docDate || null,
                    }),
                  "E-way bill generated",
                )) && setModal(null)
              }
            >
              Generate
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Distance (km; 0 = auto from PIN codes)
              <input
                type="number"
                min={0}
                value={f.distance}
                onChange={(e) => setF({ ...f, distance: e.target.value })}
              />
            </label>
            <label className="field">
              Mode
              <select
                value={f.mode}
                onChange={(e) => setF({ ...f, mode: e.target.value })}
              >
                <option value="road">Road</option>
                <option value="rail">Rail</option>
                <option value="air">Air</option>
                <option value="ship">Ship</option>
              </select>
            </label>
            <label className="field">
              Vehicle number
              <input
                value={f.vehicleNo}
                onChange={(e) =>
                  setF({ ...f, vehicleNo: e.target.value.toUpperCase() })
                }
                placeholder="UP16AB1234"
              />
            </label>
            <label className="field">
              Transporter ID (GSTIN / TRANSIN)
              <input
                value={f.transporterId}
                onChange={(e) =>
                  setF({ ...f, transporterId: e.target.value.toUpperCase() })
                }
              />
            </label>
            <label className="field">
              Transporter name
              <input
                value={f.transporterName}
                onChange={(e) =>
                  setF({ ...f, transporterName: e.target.value })
                }
              />
            </label>
            <label className="field">
              LR / RR / AWB no.
              <input
                value={f.docNo}
                onChange={(e) => setF({ ...f, docNo: e.target.value })}
              />
            </label>
            <label className="field">
              Document date
              <input
                type="date"
                value={f.docDate}
                onChange={(e) => setF({ ...f, docDate: e.target.value })}
              />
            </label>
            <div className="wide muted small">
              {irnLive
                ? "Generated through the IRP from the e-invoice."
                : "Generated on the e-way bill system from the invoice (goods lines with HSN codes)."}
            </div>
          </div>
        </Modal>
      )}
      {(modal === "cancel-irn" || modal === "cancel-ewb") && (
        <Modal
          title={modal === "cancel-irn" ? "Cancel IRN" : "Cancel e-way bill"}
          onClose={() => setModal(null)}
          footer={
            <button
              className="btn danger"
              disabled={(f.remark ?? "").trim().length < 3}
              onClick={async () =>
                (await act(
                  () =>
                    post(
                      `/api/v1/gst/invoices/${invoiceId}/${modal === "cancel-irn" ? "irn" : "eway-bill"}/cancel`,
                      { reason: f.reason, remark: f.remark },
                    ),
                  "Cancelled",
                )) && setModal(null)
              }
            >
              Cancel it
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Reason
              <select
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
              >
                <option value="data_entry_mistake">Data entry mistake</option>
                <option value="duplicate">Duplicate</option>
                <option value="order_cancelled">Order cancelled</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="field">
              Remark
              <input
                value={f.remark}
                onChange={(e) => setF({ ...f, remark: e.target.value })}
              />
            </label>
            <div className="wide muted small">
              Allowed within 24 hours of generation.
              {modal === "cancel-irn"
                ? " Cancel the invoice in SanchalanOS afterwards."
                : ""}
            </div>
          </div>
        </Modal>
      )}
      {modal === "vehicle" && (
        <Modal
          title="Update vehicle (Part B)"
          onClose={() => setModal(null)}
          footer={
            <button
              className="btn primary"
              disabled={!f.vehicleNo || (f.remark ?? "").length < 3}
              onClick={async () =>
                (await act(
                  () =>
                    post(
                      `/api/v1/gst/invoices/${invoiceId}/eway-bill/vehicle`,
                      f,
                    ),
                  "Vehicle updated",
                )) && setModal(null)
              }
            >
              Update
            </button>
          }
        >
          <div className="modal-body grid2">
            <label className="field">
              Vehicle number
              <input
                value={f.vehicleNo}
                onChange={(e) =>
                  setF({ ...f, vehicleNo: e.target.value.toUpperCase() })
                }
              />
            </label>
            <label className="field">
              From (place)
              <input
                value={f.fromPlace}
                onChange={(e) => setF({ ...f, fromPlace: e.target.value })}
              />
            </label>
            <label className="field">
              Reason
              <select
                value={f.reason}
                onChange={(e) => setF({ ...f, reason: e.target.value })}
              >
                <option value="first_time">First time</option>
                <option value="breakdown">Breakdown</option>
                <option value="transhipment">Transhipment</option>
                <option value="other">Other</option>
              </select>
            </label>
            <label className="field">
              Remark
              <input
                value={f.remark}
                onChange={(e) => setF({ ...f, remark: e.target.value })}
              />
            </label>
          </div>
        </Modal>
      )}
    </div>
  );
}
