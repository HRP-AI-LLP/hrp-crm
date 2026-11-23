/** Projects list and the project page (works for members as well as record owners). */
import { CURRENCIES } from "@synapse/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import {
  Link,
  Navigate,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { useApps, useMetaReady } from "../components/ops/OrderPanel";
import { IdeaStudio } from "../components/projects/IdeaStudio";
import { ProjectWorkspace } from "../components/projects/ProjectWorkspace";
import { Empty, Modal, Spinner, useToast } from "../components/ui";
import { get, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { date } from "../lib/format";

const PRODUCT_LABEL: Record<string, string> = {
  web_app: "Web application",
  saas: "SaaS product",
  website: "Website",
  mobile_app: "Mobile app",
  mobile_game: "Mobile game",
  desktop_app: "Desktop app",
  api_service: "API / backend",
  data_ai: "Data / AI",
  iot_embedded: "IoT / embedded",
  erp_implementation: "ERP / implementation",
  other: "Other",
};

type Json = Record<string, any>;
const STATUS_CLS: Record<string, string> = {
  planning: "info",
  active: "good",
  on_hold: "warn",
  completed: "",
  cancelled: "bad",
};
const BILLING: [string, string][] = [
  ["time_project_rate", "Hourly, one project rate"],
  ["time_staff_rate", "Hourly, each person’s rate"],
  ["time_task_rate", "Hourly, each task’s rate"],
  ["fixed_price", "Fixed price"],
  ["non_billable", "Not billable"],
];

export function ProjectsPage() {
  const apps = useApps();
  const metaReady = useMetaReady();
  const [q, setQ] = useState({ status: "open", search: "", mine: false });
  const [create, setCreate] = useState(false);
  const [idea, setIdea] = useState(false);
  const [sp, setSp] = useSearchParams();
  const github = sp.get("github");
  const params = new URLSearchParams({
    ...(q.status !== "open" && q.status !== "all" ? { status: q.status } : {}),
    ...(q.search ? { q: q.search } : {}),
    ...(q.mine ? { mine: "1" } : {}),
  });
  const { data } = useQuery({
    queryKey: ["projects", params.toString()],
    queryFn: () => get<Json[]>(`/api/v1/projects?${params}`),
    enabled: apps.has("projects"),
  });
  if (!apps.has("projects"))
    return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  const rows = (data ?? []).filter(
    (p) =>
      q.status !== "open" ||
      ["planning", "active", "on_hold"].includes(p.status),
  );
  return (
    <>
      {github && (
        <div
          className={`callout small ${github === "cancelled" ? "warn" : ""}`}
          style={{ marginBottom: 10 }}
        >
          {github === "cancelled"
            ? "The GitHub App was not installed."
            : `GitHub App installed on ${github}. Link a project’s repository from its Work setup — pick it from the list — and pull requests get the SanchalanOS check.`}{" "}
          <button
            className="link-btn small"
            onClick={() => setSp((p) => (p.delete("github"), p))}
          >
            Dismiss
          </button>
        </div>
      )}
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <p>Plan the work, track time, bill it.</p>
        </div>
        <div className="row">
          <Link className="btn" to="/timesheet">
            Timesheet
          </Link>
          <button className="btn ai" onClick={() => setIdea(true)} title="Describe an idea; HRP AI plans, documents and builds it">
            New from an idea
          </button>
          <button className="btn primary" onClick={() => setCreate(true)}>
            New project
          </button>
        </div>
      </div>
      <section className="panel">
        <div className="panel-body stack">
          <div className="row" style={{ flexWrap: "wrap" }}>
            <input
              placeholder="Search projects"
              value={q.search}
              onChange={(e) => setQ({ ...q, search: e.target.value })}
              style={{ maxWidth: 260 }}
            />
            <select
              value={q.status}
              onChange={(e) => setQ({ ...q, status: e.target.value })}
              style={{ width: "auto" }}
            >
              <option value="open">Open</option>
              <option value="all">All</option>
              <option value="planning">Planning</option>
              <option value="active">Active</option>
              <option value="on_hold">On hold</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <label className="row small">
              <input
                type="checkbox"
                checked={q.mine}
                onChange={(e) => setQ({ ...q, mine: e.target.checked })}
              />{" "}
              Mine
            </label>
          </div>
          {!data ? (
            <Spinner />
          ) : !rows.length ? (
            <Empty title="No projects here">
              Create one, or ask a project manager to add you to theirs.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Project</th>
                    <th>Customer</th>
                    <th>Manager</th>
                    <th>Status</th>
                    <th>Progress</th>
                    <th className="num">Open tasks</th>
                    <th className="num">Hours</th>
                    <th>Ends</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((p) => (
                    <tr key={p.id}>
                      <td>
                        <Link to={`/projects/${p.id}`}>
                          {p.project_code ? (
                            <span className="muted">{p.project_code} · </span>
                          ) : null}
                          {p.name}
                        </Link>
                        {p.repos === 0 &&
                          !["completed", "cancelled"].includes(p.status) && (
                            <span
                              className="chip warn"
                              style={{ marginLeft: 6 }}
                              title="No code repository linked — Work setup → Code repositories"
                            >
                              no repo
                            </span>
                          )}
                      </td>
                      <td>
                        {p.project_kind === "in_house" ? (
                          <span className="chip info">In-house</span>
                        ) : (
                          (p.customer ?? "—")
                        )}
                        {p.product_type && (
                          <div className="small muted">
                            {PRODUCT_LABEL[p.product_type] ?? p.product_type}
                          </div>
                        )}
                      </td>
                      <td>{p.manager ?? "—"}</td>
                      <td>
                        <span className={`chip ${STATUS_CLS[p.status] ?? ""}`}>
                          {p.status.replace("_", " ")}
                        </span>
                      </td>
                      <td style={{ minWidth: 120 }}>
                        <div
                          style={{
                            background: "var(--line)",
                            borderRadius: 4,
                            height: 8,
                          }}
                        >
                          <div
                            style={{
                              width: `${Math.min(100, p.progress)}%`,
                              background: "var(--accent)",
                              height: 8,
                              borderRadius: 4,
                            }}
                          />
                        </div>
                        <span className="small muted">
                          {Math.round(p.progress)}%
                        </span>
                      </td>
                      <td className="num">
                        {p.open_tasks}
                        {p.overdue_tasks ? (
                          <span className="chip bad" style={{ marginLeft: 6 }}>
                            {p.overdue_tasks} late
                          </span>
                        ) : null}
                      </td>
                      <td className="num">
                        {Math.round(p.hours * 10) / 10}
                        {p.budget_hours ? (
                          <span className="muted"> / {p.budget_hours}</span>
                        ) : null}
                      </td>
                      <td>{date(p.end_date)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
      {create && <NewProject onClose={() => setCreate(false)} />}
      {idea && <IdeaStudio onClose={() => setIdea(false)} />}
    </>
  );
}

function NewProject({ onClose }: { onClose: () => void }) {
  const nav = useNavigate();
  const toast = useToast();
  const accounts = useQuery({
    queryKey: ["accounts-pick"],
    queryFn: () =>
      get<{ items: Json[] }>(
        "/api/v1/records/account?limit=200&sort=name&dir=asc",
      ),
  });
  const [f, setF] = useState({
    project_kind: "client",
    product_type: "",
    name: "",
    project_code: "",
    account_id: "",
    billing_method: "time_project_rate",
    project_rate: "",
    fixed_fee: "",
    start_date: new Date().toISOString().slice(0, 10),
    end_date: "",
    budget_hours: "",
    currency: "INR",
  });
  return (
    <Modal
      title="New project"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!f.name.trim()}
          onClick={async () => {
            try {
              const inHouse = f.project_kind === "in_house";
              const body: Json = {
                name: f.name.trim(),
                project_kind: f.project_kind,
                billing_method: inHouse ? "non_billable" : f.billing_method,
                start_date: f.start_date || null,
                currency: f.currency,
              };
              if (f.product_type) body.product_type = f.product_type;
              if (f.project_code) body.project_code = f.project_code;
              if (f.account_id && !inHouse) body.account_id = f.account_id;
              if (f.project_rate) body.project_rate = Number(f.project_rate);
              if (f.fixed_fee) body.fixed_fee = Number(f.fixed_fee);
              if (f.end_date) body.end_date = f.end_date;
              if (f.budget_hours)
                Object.assign(body, {
                  budget_type: "hours",
                  budget_hours: Number(f.budget_hours),
                });
              const r = await post<{ id: string }>(
                "/api/v1/records/project",
                body,
              );
              nav(`/projects/${r.id}`);
            } catch (e) {
              toast((e as Error).message, true);
            }
          }}
        >
          Create
        </button>
      }
    >
      <div className="modal-body grid2">
        <label className="field wide">
          Name
          <input
            value={f.name}
            onChange={(e) => setF({ ...f, name: e.target.value })}
            autoFocus
          />
        </label>
        <label className="field">
          Code
          <input
            value={f.project_code}
            onChange={(e) => setF({ ...f, project_code: e.target.value })}
          />
        </label>
        <label className="field">
          For
          <select
            value={f.project_kind}
            onChange={(e) => setF({ ...f, project_kind: e.target.value })}
          >
            <option value="client">A client</option>
            <option value="in_house">In-house — our own product</option>
          </select>
        </label>
        <label className="field">
          What is being built
          <select
            value={f.product_type}
            onChange={(e) => setF({ ...f, product_type: e.target.value })}
          >
            <option value="">—</option>
            {Object.entries(PRODUCT_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
        </label>
        {f.project_kind === "client" && (
          <label className="field">
            Customer
            <select
              value={f.account_id}
              onChange={(e) => setF({ ...f, account_id: e.target.value })}
            >
              <option value="">—</option>
              {(accounts.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.title}
                </option>
              ))}
            </select>
          </label>
        )}
        {f.project_kind === "client" && (
          <label className="field">
            Billing
            <select
              value={f.billing_method}
              onChange={(e) => setF({ ...f, billing_method: e.target.value })}
            >
              {BILLING.map(([k, l]) => (
                <option key={k} value={k}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        )}
        <label className="field">
          Currency
          <select
            value={f.currency}
            onChange={(e) => setF({ ...f, currency: e.target.value })}
          >
            {CURRENCIES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </label>
        {f.project_kind === "in_house" ? null : f.billing_method ===
          "fixed_price" ? (
          <label className="field">
            Fixed fee ({f.currency})
            <input
              inputMode="decimal"
              value={f.fixed_fee}
              onChange={(e) => setF({ ...f, fixed_fee: e.target.value })}
            />
          </label>
        ) : (
          <label className="field">
            Hourly rate ({f.currency})
            <input
              inputMode="decimal"
              value={f.project_rate}
              onChange={(e) => setF({ ...f, project_rate: e.target.value })}
            />
          </label>
        )}
        <label className="field">
          Starts
          <input
            type="date"
            value={f.start_date}
            onChange={(e) => setF({ ...f, start_date: e.target.value })}
          />
        </label>
        <label className="field">
          Ends
          <input
            type="date"
            value={f.end_date}
            onChange={(e) => setF({ ...f, end_date: e.target.value })}
          />
        </label>
        <label className="field">
          Budget (hours)
          <input
            inputMode="decimal"
            value={f.budget_hours}
            onChange={(e) => setF({ ...f, budget_hours: e.target.value })}
          />
        </label>
      </div>
    </Modal>
  );
}

export function ProjectPage() {
  const { id } = useParams();
  const { me } = useAuth();
  const apps = useApps();
  const metaReady = useMetaReady();
  const { data, error } = useQuery({
    queryKey: ["project", id],
    queryFn: () => get<Json>(`/api/v1/projects/${id}`),
    enabled: !!id && apps.has("projects"),
  });
  if (!apps.has("projects"))
    return metaReady ? <Navigate to="/" replace /> : <Spinner />;
  if (error)
    return (
      <Empty title="Project not found">
        It may have been deleted, or you are not on its team.
      </Empty>
    );
  if (!data || !me) return <Spinner />;
  const p = data.project;
  return (
    <>
      <div className="page-head">
        <div>
          <div className="small muted">
            <Link to="/projects">Projects</Link>
            {p.project_code ? ` · ${p.project_code}` : ""}
          </div>
          <h1>{p.title}</h1>
          <p
            className="row small"
            style={{ gap: 12, flexWrap: "wrap", margin: 0 }}
          >
            <span className={`chip ${STATUS_CLS[p.status] ?? ""}`}>
              {String(p.status).replace("_", " ")}
            </span>
            {p.project_kind === "in_house" && (
              <span className="chip info">In-house</span>
            )}
            {p.product_type && (
              <span className="chip">
                {PRODUCT_LABEL[p.product_type] ?? p.product_type}
              </span>
            )}
            {p.manager && <span>Manager: {p.manager}</span>}
            {(p.start_date || p.end_date) && (
              <span>
                {date(p.start_date)} → {date(p.end_date)}
              </span>
            )}
            <span className="muted">Your access: {data.level}</span>
          </p>
        </div>
        {data.level === "manage" && (
          <Link className="btn" to={`/o/project/${id}`}>
            Edit details
          </Link>
        )}
      </div>
      <ProjectWorkspace id={id!} />
    </>
  );
}
