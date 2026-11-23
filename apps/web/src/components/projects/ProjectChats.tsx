/**
 * The project's WhatsApp chats: customers' one-to-one threads, project groups and exported chats,
 * read by the AI into suggestions — bugs, requirements, stories, tasks, change requests, calls,
 * questions and follow-ups — that become work with one click (or on their own in "auto").
 */
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { unzipSync, strFromU8 } from "fflate";
import { useState } from "react";
import { del, get, patch, post, upload } from "../../lib/api";
import { date } from "../../lib/format";
import { Empty, Modal, Spinner, useToast } from "../ui";
import { Guide } from "../admin/ConnectionKeys";
import { useTeam } from "./WorkItem";

type Json = Record<string, any>;

const KIND_LABEL: Record<string, string> = {
  bug: "Bug",
  requirement: "Requirement",
  story: "Story",
  task: "Task",
  change_request: "Change request",
  call: "Call",
  question: "Question to answer",
  follow_up: "Follow-up",
};
const KIND_CHIP: Record<string, string> = {
  bug: "bad",
  change_request: "warn",
  requirement: "good",
  story: "good",
  call: "",
  question: "warn",
  follow_up: "",
  task: "",
};
const MODE: [string, string, string][] = [
  [
    "suggest",
    "Suggest",
    "the AI proposes; someone on the project creates each with one click",
  ],
  [
    "auto",
    "Create automatically",
    "items the AI is fairly sure of become work at once (calls still need a time)",
  ],
  ["off", "Off", "messages are kept, not read"],
];
const KIND_LINE: Record<string, string> = {
  contact: "Customer chat",
  group: "Project group",
  import: "Exported chat",
};
const when = (s: string | null | undefined) =>
  s
    ? new Date(s).toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "numeric",
        minute: "2-digit",
      })
    : "—";

function useAct() {
  const toast = useToast();
  return async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | null> => {
    try {
      const r = await fn();
      if (ok) toast(ok);
      return r;
    } catch (e) {
      toast((e as Error).message, true);
      return null;
    }
  };
}

export function ProjectChats({ id }: { id: string }) {
  const { data, refetch } = useQuery({
    queryKey: ["project-chats", id],
    queryFn: () => get<Json>(`/api/v1/projects/${id}/chats`),
    refetchInterval: 60_000,
  });
  const [modal, setModal] = useState<null | "link" | "group" | "import">(null);
  const [importInto, setImportInto] = useState<Json | null>(null);
  const [open, setOpen] = useState<Json | null>(null);
  const [show, setShow] = useState<"proposed" | "done">("proposed");
  const act = useAct();
  const toast = useToast();
  if (!data) return <Spinner />;
  const chats = data.chats as Json[];
  const props = (data.proposals as Json[]).filter((p) =>
    show === "proposed" ? p.status === "proposed" : p.status !== "proposed",
  );
  const openCount = (data.proposals as Json[]).filter(
    (p) => p.status === "proposed",
  ).length;
  return (
    <div className="stack">
      <Guide id="project_whatsapp" />
      <div
        className="row"
        style={{ justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}
      >
        <div>
          <h3 className="section-label" style={{ margin: 0 }}>
            WhatsApp chats
          </h3>
          <div className="small muted">
            Customer chats and groups on this project. The AI reads what's new
            once a chat goes quiet and turns it into work.
          </div>
        </div>
        {data.canManage && (
          <div className="row" style={{ gap: 6 }}>
            <button className="btn primary" onClick={() => setModal("link")}>
              + Link a customer chat
            </button>
            <button className="btn" onClick={() => setModal("group")}>
              New project group
            </button>
            <button
              className="btn"
              onClick={() => (setImportInto(null), setModal("import"))}
            >
              Import an exported chat
            </button>
          </div>
        )}
      </div>

      {!chats.length ? (
        <Empty title="No chats yet">
          Link a customer's WhatsApp thread, make a project group, or upload a
          chat exported from any WhatsApp group (⋮ → More → Export chat).
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Chat</th>
                <th>AI</th>
                <th className="num">Messages</th>
                <th>Last message</th>
                <th className="num">To review</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {chats.map((c) => (
                <tr key={c.id} className="click" onClick={() => setOpen(c)}>
                  <td>
                    <b>{c.title}</b>
                    <div className="small muted">
                      {KIND_LINE[c.kind]}
                      {c.address && c.kind === "contact"
                        ? ` · +${c.address}`
                        : ""}
                      {c.group_pending
                        ? " · WhatsApp is creating the group…"
                        : ""}
                    </div>
                    {c.invite_link && (
                      <div className="small">
                        Invite link:{" "}
                        <a
                          href={c.invite_link}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {c.invite_link}
                        </a>
                      </div>
                    )}
                    {c.last_error && (
                      <div className="small" style={{ color: "var(--bad)" }}>
                        {c.last_error}
                      </div>
                    )}
                  </td>
                  <td onClick={(e) => e.stopPropagation()}>
                    {data.canManage ? (
                      <select
                        style={{ minWidth: 170 }}
                        value={c.mode}
                        onChange={async (e) =>
                          (await act(
                            () =>
                              patch(`/api/v1/projects/${id}/chats/${c.id}`, {
                                mode: e.target.value,
                              }),
                            "Saved",
                          )) !== null && refetch()
                        }
                      >
                        {MODE.map(([k, l]) => (
                          <option key={k} value={k}>
                            {l}
                          </option>
                        ))}
                      </select>
                    ) : (
                      MODE.find((m) => m[0] === c.mode)?.[1]
                    )}
                  </td>
                  <td className="num">{c.messages}</td>
                  <td>
                    {when(c.last_message_at)}
                    <div className="small muted">
                      {c.pending_since ? (
                        <span className="chip warn">
                          new — AI reads it soon
                        </span>
                      ) : c.last_analysed_at ? (
                        `read ${when(c.last_analysed_at)}`
                      ) : (
                        ""
                      )}
                    </div>
                  </td>
                  <td className="num">
                    {c.open_proposals ? (
                      <span className="chip warn">{c.open_proposals}</span>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="nowrap" onClick={(e) => e.stopPropagation()}>
                    {data.canAct && (
                      <button
                        className="btn small"
                        title="Read what's new now instead of waiting for the chat to go quiet"
                        onClick={async () => {
                          const r = await act(() =>
                            post<Json>(
                              `/api/v1/projects/${id}/chats/${c.id}/analyse`,
                            ),
                          );
                          if (r) {
                            refetch();
                            toast(
                              r.proposals
                                ? `${r.proposals} new from the chat${r.created ? ` (${r.created} created)` : ""}`
                                : "Nothing new to act on",
                            );
                          }
                        }}
                      >
                        Read now
                      </button>
                    )}{" "}
                    {c.kind === "import" && data.canManage && (
                      <button
                        className="btn small"
                        onClick={() => (setImportInto(c), setModal("import"))}
                      >
                        Upload newer export
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div
        className="row"
        style={{ justifyContent: "space-between", marginTop: 8 }}
      >
        <h3 className="section-label" style={{ margin: 0 }}>
          From the chats
        </h3>
        <div className="seg">
          <button
            aria-pressed={show === "proposed"}
            onClick={() => setShow("proposed")}
          >
            To review ({openCount})
          </button>
          <button
            aria-pressed={show === "done"}
            onClick={() => setShow("done")}
          >
            Handled (30 days)
          </button>
        </div>
      </div>
      {!props.length ? (
        <p className="small muted">
          {show === "proposed"
            ? "Nothing waiting. New suggestions appear here when the AI has read a chat."
            : "Nothing handled in the last 30 days."}
        </p>
      ) : (
        <div className="stack" style={{ gap: 8 }}>
          {props.map((p) => (
            <Proposal
              key={p.id}
              p={p}
              projectId={id}
              canAct={data.canAct}
              onDone={refetch}
              plan={data}
            />
          ))}
        </div>
      )}

      {modal === "link" && (
        <LinkChat
          projectId={id}
          onClose={() => setModal(null)}
          onDone={refetch}
        />
      )}
      {modal === "group" && (
        <NewGroup
          projectId={id}
          onClose={() => setModal(null)}
          onDone={refetch}
        />
      )}
      {modal === "import" && (
        <ImportChat
          projectId={id}
          chat={importInto}
          onClose={() => setModal(null)}
          onDone={refetch}
        />
      )}
      {open && (
        <ChatView
          projectId={id}
          chat={open}
          canManage={data.canManage}
          onClose={() => setOpen(null)}
          onChanged={refetch}
        />
      )}
    </div>
  );
}

const SEV: Record<string, [string, string]> = {
  blocker: ["Blocker", "bad"],
  critical: ["Critical", "bad"],
  major: ["Major", "warn"],
  minor: ["Minor", ""],
};
const WORK = ["bug", "story", "requirement", "task"];

/** Where a suggested work item goes: severity, size, epic, release and who works on it. */
function PlanChips({ p, plan }: { p: Json; plan: Json }) {
  const pl = p.plan as Json | undefined;
  if (!WORK.includes(p.kind) || !pl) return null;
  const sev = SEV[p.severity ?? ""] ?? null;
  const who =
    plan.defaultAssignee === "agent"
      ? (plan.agent?.name ?? "HRP AI")
      : plan.defaultAssignee === "none"
        ? null
        : "the default person";
  return (
    <div
      className="row small"
      style={{ gap: 6, flexWrap: "wrap", marginTop: 6 }}
    >
      {sev && <span className={`chip ${sev[1]}`}>{sev[0]}</span>}
      {p.story_points != null && (
        <span className="chip">{Number(p.story_points)} pts</span>
      )}
      {p.estimate_hours != null && (
        <span className="chip">{Number(p.estimate_hours)} h</span>
      )}
      {pl.epic && (
        <span
          className="chip"
          title={
            pl.epic.isNew ? "A new epic — made when you create this" : "Epic"
          }
        >
          Epic: {pl.epic.label}
          {pl.epic.isNew ? " (new)" : ""}
        </span>
      )}
      {pl.release && (
        <span
          className="chip"
          title={
            pl.release.isNew
              ? "A new release — made when you create this"
              : "Release"
          }
        >
          Release: {pl.release.label}
          {pl.release.isNew ? " (new)" : ""}
        </span>
      )}
      {who && p.status === "proposed" && (
        <span className="chip info">→ {who}</span>
      )}
    </div>
  );
}

function Proposal({
  p,
  projectId,
  canAct,
  onDone,
  plan,
}: {
  p: Json;
  projectId: string;
  canAct: boolean;
  onDone: () => void;
  plan: Json;
}) {
  const act = useAct();
  const team = useTeam(projectId);
  const [edit, setEdit] = useState<Json | null>(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);
  const accept = async (body: Json = {}) => {
    setBusy(true);
    const r = await act(
      () =>
        post<Json>(
          `/api/v1/projects/${projectId}/chat-proposals/${p.id}/accept`,
          body,
        ),
      "Created",
    );
    setBusy(false);
    if (r) {
      if (r.attached)
        toast(
          `${r.attached} file${r.attached === 1 ? "" : "s"} from the chat attached`,
        );
      setEdit(null);
      setOpen(false);
      onDone();
    }
  };
  const toast = useToast();
  const dismiss = async () => {
    if (
      (await act(() =>
        post(`/api/v1/projects/${projectId}/chat-proposals/${p.id}/dismiss`),
      )) !== null
    )
      (setOpen(false), onDone());
  };
  const createLabel =
    p.kind === "call"
      ? "Schedule"
      : p.kind === "question" || p.kind === "follow_up"
        ? "Add to-do"
        : "Create";
  // a new epic or release is made only with the person's say-so
  const newOnes = [
    p.plan?.epic?.isNew ? `the epic “${p.plan.epic.label}”` : null,
    p.plan?.release?.isNew ? `the release “${p.plan.release.label}”` : null,
  ].filter(Boolean);
  const createNow = () =>
    p.kind === "call" && !p.starts_at
      ? setEdit({ ...p, startsAt: "" })
      : newOnes.length &&
          !confirm(`This also creates ${newOnes.join(" and ")}. Go ahead?`)
        ? undefined
        : accept();
  const editOf = () => ({
    ...p,
    startsAt: startsLocal(p.starts_at),
    epic: p.plan?.epic?.id ?? p.plan?.epic?.label ?? "",
    release: p.plan?.release?.id ?? p.release_ref ?? "next",
    storyPoints: p.story_points ?? "",
    estimateHours: p.estimate_hours ?? "",
    assignee: "",
  });
  const startsLocal = (s: string | null) =>
    s
      ? new Date(
          new Date(s).getTime() - new Date().getTimezoneOffset() * 60_000,
        )
          .toISOString()
          .slice(0, 16)
      : "";
  return (
    <div className="panel" style={{ padding: 10 }}>
      <div
        className="row"
        style={{
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: 8,
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
            <span className={`chip ${KIND_CHIP[p.kind] ?? ""}`}>
              {KIND_LABEL[p.kind] ?? p.kind}
            </span>
            <button
              type="button"
              className="link-btn"
              style={{ fontWeight: 600, textAlign: "left" }}
              onClick={() => setOpen(true)}
              title="See everything behind it"
            >
              {p.title}
            </button>
            {p.priority === "high" && <span className="chip bad">high</span>}
            {!p.ai && (
              <span
                className="chip"
                title="Found by keyword rules (the AI was not available)"
              >
                rules
              </span>
            )}
          </div>
          {p.detail && (
            <div className="small" style={{ marginTop: 4 }}>
              {p.detail}
            </div>
          )}
          {p.quote && (
            <div
              className="small muted"
              style={{
                marginTop: 4,
                borderLeft: "3px solid var(--line)",
                paddingLeft: 8,
              }}
            >
              “{p.quote}”
            </div>
          )}
          <PlanChips p={p} plan={plan} />
          <div className="small muted" style={{ marginTop: 4 }}>
            {p.chat_title}
            {p.requested_by ? ` · ${p.requested_by}` : ""}
            {p.message_at ? ` · ${when(p.message_at)}` : ""}
            {p.due ? ` · due ${date(p.due)}` : ""}
            {p.starts_at ? ` · ${when(p.starts_at)}` : ""}
            {p.status === "proposed"
              ? ` · ${Math.round(p.confidence * 100)}% sure`
              : ""}
            {" · "}
            <button
              type="button"
              className="link-btn small"
              onClick={() => setOpen(true)}
            >
              {(p.message_ids?.length ?? 0) > 1
                ? `${p.message_ids.length} messages & files`
                : "Details & files"}
            </button>
          </div>
        </div>
        <div className="row nowrap" style={{ gap: 6 }}>
          {p.status === "created" ? (
            <span className="chip good">
              {p.created_key ?? "Created"}
              {p.created_object === "call"
                ? " · call scheduled"
                : p.created_object === "action_item"
                  ? " · on the to-do list"
                  : ""}
            </span>
          ) : p.status === "dismissed" ? (
            <span className="chip">Dismissed</span>
          ) : canAct ? (
            <>
              <button
                className="btn small primary"
                disabled={busy}
                onClick={createNow}
              >
                {createLabel}
              </button>
              <button
                className="btn small"
                disabled={busy}
                onClick={() => setEdit(editOf())}
              >
                Edit…
              </button>
              <button
                className="btn small ghost"
                disabled={busy}
                onClick={dismiss}
              >
                Dismiss
              </button>
            </>
          ) : null}
        </div>
      </div>
      {open && (
        <ProposalDetail
          projectId={projectId}
          p={p}
          onClose={() => setOpen(false)}
          actions={
            p.status === "proposed" && canAct ? (
              <>
                <button className="btn ghost" disabled={busy} onClick={dismiss}>
                  Dismiss
                </button>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => setEdit(editOf())}
                >
                  Edit…
                </button>
                <button
                  className="btn primary"
                  disabled={busy}
                  onClick={createNow}
                >
                  {createLabel}
                </button>
              </>
            ) : null
          }
        />
      )}
      {edit && (
        <Modal
          title="Before creating"
          onClose={() => setEdit(null)}
          footer={
            <button
              className="btn primary"
              disabled={
                busy ||
                !edit.title.trim() ||
                (edit.kind === "call" && !edit.startsAt)
              }
              onClick={() =>
                accept({
                  kind: edit.kind,
                  title: edit.title.trim(),
                  detail: edit.detail || null,
                  priority: edit.priority,
                  due: edit.due ? String(edit.due).slice(0, 10) : null,
                  ...(edit.kind === "call" && edit.startsAt
                    ? { startsAt: new Date(edit.startsAt).toISOString() }
                    : {}),
                  ...(WORK.includes(edit.kind)
                    ? {
                        ...(edit.severity ? { severity: edit.severity } : {}),
                        ...(edit.storyPoints !== "" && edit.storyPoints != null
                          ? { storyPoints: Number(edit.storyPoints) }
                          : {}),
                        ...(edit.estimateHours !== "" &&
                        edit.estimateHours != null
                          ? { estimateHours: Number(edit.estimateHours) }
                          : {}),
                        ...(String(edit.epic ?? "").trim()
                          ? { epic: String(edit.epic).trim() }
                          : {}),
                        ...(String(edit.release ?? "").trim()
                          ? { release: String(edit.release).trim() }
                          : {}),
                        ...(edit.assignee
                          ? { assignees: [edit.assignee] }
                          : {}),
                      }
                    : {}),
                })
              }
            >
              {edit.kind === "call" ? "Schedule the call" : "Create"}
            </button>
          }
        >
          <div className="modal-body stack">
            <label className="field">
              Make it a
              <select
                value={edit.kind}
                onChange={(e) => setEdit({ ...edit, kind: e.target.value })}
              >
                {Object.entries(KIND_LABEL).map(([k, l]) => (
                  <option key={k} value={k}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              Title
              <input
                value={edit.title}
                onChange={(e) => setEdit({ ...edit, title: e.target.value })}
              />
            </label>
            <label className="field">
              Details
              <textarea
                rows={4}
                value={edit.detail ?? ""}
                onChange={(e) => setEdit({ ...edit, detail: e.target.value })}
              />
            </label>
            <div className="grid2">
              <label className="field">
                Priority
                <select
                  value={edit.priority}
                  onChange={(e) =>
                    setEdit({ ...edit, priority: e.target.value })
                  }
                >
                  <option value="high">High</option>
                  <option value="medium">Medium</option>
                  <option value="low">Low</option>
                </select>
              </label>
              {edit.kind === "call" ? (
                <label className="field">
                  When
                  <input
                    type="datetime-local"
                    value={edit.startsAt}
                    onChange={(e) =>
                      setEdit({ ...edit, startsAt: e.target.value })
                    }
                  />
                </label>
              ) : (
                <label className="field">
                  Due
                  <input
                    type="date"
                    value={edit.due ? String(edit.due).slice(0, 10) : ""}
                    onChange={(e) => setEdit({ ...edit, due: e.target.value })}
                  />
                </label>
              )}
            </div>
            {WORK.includes(edit.kind) && (
              <>
                <div className="grid2">
                  <label className="field">
                    Severity
                    <select
                      value={edit.severity ?? ""}
                      onChange={(e) =>
                        setEdit({ ...edit, severity: e.target.value })
                      }
                    >
                      <option value="">Let the AI decide</option>
                      <option value="blocker">
                        Blocker — they cannot work
                      </option>
                      <option value="critical">
                        Critical — a main function is down
                      </option>
                      <option value="major">
                        Major — a function is wrong or missing
                      </option>
                      <option value="minor">Minor — cosmetic or small</option>
                    </select>
                  </label>
                  <label className="field">
                    Assignee
                    <select
                      value={edit.assignee}
                      onChange={(e) =>
                        setEdit({ ...edit, assignee: e.target.value })
                      }
                    >
                      <option value="">
                        {plan.defaultAssignee === "agent"
                          ? `Default: ${plan.agent?.name ?? "HRP AI"} (coding agent)`
                          : "The project’s default"}
                      </option>
                      {team.map(([id, name]) => (
                        <option key={id} value={id}>
                          {name}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Story points
                    <select
                      value={
                        edit.storyPoints === "" || edit.storyPoints == null
                          ? ""
                          : String(Number(edit.storyPoints))
                      }
                      onChange={(e) =>
                        setEdit({ ...edit, storyPoints: e.target.value })
                      }
                    >
                      <option value="">Let the AI decide</option>
                      {[0.5, 1, 2, 3, 5, 8, 13, 21].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    Hours (estimate)
                    <input
                      inputMode="decimal"
                      value={edit.estimateHours ?? ""}
                      onChange={(e) =>
                        setEdit({ ...edit, estimateHours: e.target.value })
                      }
                    />
                  </label>
                  <label className="field">
                    Epic
                    <input
                      list={`epics-${p.id}`}
                      value={
                        edit.epic &&
                        (plan.epics as Json[]).find((x) => x.id === edit.epic)
                          ? (plan.epics as Json[]).find(
                              (x) => x.id === edit.epic,
                            )!.name
                          : (edit.epic ?? "")
                      }
                      onChange={(e) => {
                        const hit = (plan.epics as Json[]).find(
                          (x) => x.name === e.target.value,
                        );
                        setEdit({
                          ...edit,
                          epic: hit ? hit.id : e.target.value,
                        });
                      }}
                      placeholder="Choose, or type a new epic"
                    />
                    <datalist id={`epics-${p.id}`}>
                      {(plan.epics as Json[]).map((x) => (
                        <option key={x.id} value={x.name}>
                          {x.key}
                        </option>
                      ))}
                    </datalist>
                    <small className="muted">
                      {edit.epic &&
                      !(plan.epics as Json[]).some(
                        (x) => x.id === edit.epic || x.name === edit.epic,
                      )
                        ? "A new epic — made when you create this"
                        : ""}
                    </small>
                  </label>
                  <label className="field">
                    Release
                    <select
                      value={edit.release ?? "next"}
                      onChange={(e) =>
                        setEdit({ ...edit, release: e.target.value })
                      }
                    >
                      {(plan.releases as Json[]).map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                          {x.version ? ` ${x.version}` : ""} ({x.release_type})
                        </option>
                      ))}
                      {!(plan.releases as Json[]).some(
                        (x) => x.release_type !== "hotfix",
                      ) && (
                        <option value="next">
                          A new “Next release” (made when you create this)
                        </option>
                      )}
                      {!(plan.releases as Json[]).some(
                        (x) => x.release_type === "hotfix",
                      ) && (
                        <option value="hotfix">
                          A new hotfix release (made when you create this)
                        </option>
                      )}
                    </select>
                  </label>
                </div>
              </>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
}

function ModeChoice({ mode, set }: { mode: string; set: (m: string) => void }) {
  return (
    <div className="field">
      What the AI does
      {MODE.map(([k, l, d]) => (
        <label
          key={k}
          className="row small"
          style={{ gap: 6, alignItems: "flex-start" }}
        >
          <input type="radio" checked={mode === k} onChange={() => set(k)} />
          <span>
            <strong>{l}</strong> — {d}
          </span>
        </label>
      ))}
    </div>
  );
}

function LinkChat({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["project-chats", projectId, "choices"],
    queryFn: () => get<Json>(`/api/v1/projects/${projectId}/chats/choices`),
  });
  const [q, setQ] = useState("");
  const [pick, setPick] = useState<Json | null>(null);
  const [mode, setMode] = useState("suggest");
  const [history, setHistory] = useState(true);
  const [account, setAccount] = useState("");
  const act = useAct();
  if (!data) return null;
  const ql = q.trim().toLowerCase();
  const convs = (data.conversations as Json[]).filter(
    (c) =>
      !ql || `${c.display_name ?? ""} ${c.address}`.toLowerCase().includes(ql),
  );
  const groups = (data.groups as Json[]).filter(
    (g) => g.group_id && !g.linked_to,
  );
  const people = ((data.contacts ?? []) as Json[]).filter(
    (c) =>
      !ql ||
      `${c.full_name} ${c.number} ${c.account ?? ""}`
        .toLowerCase()
        .includes(ql),
  );
  return (
    <Modal
      title="Link a customer chat"
      onClose={onClose}
      wide
      footer={
        <button
          className="btn primary"
          disabled={!pick}
          onClick={async () => {
            const target = pick!.group
              ? { waGroupId: pick!.id }
              : pick!.contact
                ? { contactId: pick!.id, channelAccountId: account || null }
                : { conversationId: pick!.id };
            const r = await act(
              () =>
                post<Json>(`/api/v1/projects/${projectId}/chats`, {
                  ...target,
                  mode,
                  readHistory: history,
                }),
              "Linked",
            );
            if (r) (onDone(), onClose());
          }}
        >
          Link
        </button>
      }
    >
      <div className="modal-body stack">
        {!data.accounts.length ? (
          <div className="callout warn small">
            No WhatsApp Business number is connected yet (Settings → Channels →
            WhatsApp). Until then, use <b>Import an exported chat</b>.
          </div>
        ) : (
          <>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={`Search ${data.conversations.length} WhatsApp chats and ${(data.contacts ?? []).length} contacts by name or number…`}
            />
            <p className="small muted" style={{ margin: 0 }}>
              Chats appear here once someone writes to your WhatsApp Business
              number{data.accounts.length > 1 ? "s" : ""} — WhatsApp does not
              share your phone's older chats or contact list. Contacts with a
              mobile number can be linked now; the first message to them must be
              an approved template.
            </p>
            <div
              className="repo-pick"
              style={{ maxHeight: 320, overflowY: "auto" }}
            >
              {groups.map((g) => (
                <label
                  key={g.id}
                  className="repo-opt row small"
                  style={{ gap: 8 }}
                >
                  <input
                    type="radio"
                    name="chat"
                    checked={pick?.id === g.id}
                    onChange={() => setPick({ ...g, group: true })}
                  />
                  <b>{g.subject ?? "WhatsApp group"}</b>{" "}
                  <span className="chip">group</span>
                </label>
              ))}
              {convs.map((c) => (
                <label
                  key={c.id}
                  className="repo-opt row small"
                  style={{ gap: 8, opacity: c.linked_here ? 0.6 : 1 }}
                >
                  <input
                    type="radio"
                    name="chat"
                    disabled={c.linked_here}
                    checked={pick?.id === c.id}
                    onChange={() => setPick(c)}
                  />
                  <span>
                    <b>{c.display_name ?? `+${c.address}`}</b>{" "}
                    <span className="muted">+{c.address}</span>
                    {c.linked_here && (
                      <span className="chip good" style={{ marginLeft: 6 }}>
                        on this project
                      </span>
                    )}
                    {c.linked_elsewhere && (
                      <span className="muted">
                        {" "}
                        · also on {c.linked_elsewhere}
                      </span>
                    )}
                    <div className="muted">
                      {when(c.last_message_at)} · {c.last_preview}
                    </div>
                  </span>
                </label>
              ))}
              {people.length > 0 && (
                <div
                  className="small muted"
                  style={{ padding: "6px 4px 2px", fontWeight: 600 }}
                >
                  Contacts not on WhatsApp chat yet
                </div>
              )}
              {people.map((c) => (
                <label
                  key={`c-${c.id}`}
                  className="repo-opt row small"
                  style={{ gap: 8 }}
                >
                  <input
                    type="radio"
                    name="chat"
                    checked={pick?.contact && pick.id === c.id}
                    onChange={() => setPick({ ...c, contact: true })}
                  />
                  <span>
                    <b>{c.full_name}</b>{" "}
                    <span className="muted">+{c.number}</span>
                    {c.of_customer && (
                      <span className="chip info" style={{ marginLeft: 6 }}>
                        project's customer
                      </span>
                    )}
                    {c.account && <div className="muted">{c.account}</div>}
                  </span>
                </label>
              ))}
              {!convs.length && !groups.length && !people.length && (
                <span className="muted small">
                  No chats yet: they appear once a customer writes to your
                  WhatsApp Business number. Add a mobile number to the
                  customer's contacts to link them before they write.
                </span>
              )}
            </div>
          </>
        )}
        {pick?.contact && data.accounts.length > 1 && (
          <label className="field">
            Chat from
            <select
              value={account || data.accounts[0].id}
              onChange={(e) => setAccount(e.target.value)}
            >
              {(data.accounts as Json[]).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <ModeChoice mode={mode} set={setMode} />
        <label className="row small" style={{ gap: 6 }}>
          <input
            type="checkbox"
            checked={history}
            onChange={(e) => setHistory(e.target.checked)}
          />{" "}
          Also read the last 30 days of the chat now
        </label>
        <p className="small muted" style={{ margin: 0 }}>
          A chat can be on more than one project; a project can have any number
          of chats.
        </p>
      </div>
    </Modal>
  );
}

function NewGroup({
  projectId,
  onClose,
  onDone,
}: {
  projectId: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["project-chats", projectId, "choices"],
    queryFn: () => get<Json>(`/api/v1/projects/${projectId}/chats/choices`),
  });
  const [f, setF] = useState({
    channelAccountId: "",
    subject: "",
    description: "",
    mode: "suggest",
  });
  const act = useAct();
  if (!data) return null;
  const acc = f.channelAccountId || data.accounts[0]?.id || "";
  return (
    <Modal
      title="New WhatsApp group for the project"
      onClose={onClose}
      footer={
        <button
          className="btn primary"
          disabled={!acc || !f.subject.trim()}
          onClick={async () => {
            const r = await act(
              () =>
                post<Json>(`/api/v1/projects/${projectId}/chats/group`, {
                  ...f,
                  channelAccountId: acc,
                  subject: f.subject.trim(),
                  description: f.description || null,
                }),
              "Group requested",
            );
            if (r) (onDone(), onClose());
          }}
        >
          Create the group
        </button>
      }
    >
      <div className="modal-body stack">
        <div className="callout small">
          Made on your WhatsApp Business number through WhatsApp's Groups API:
          up to 8 people, who join with an invite link (shown here once WhatsApp
          confirms the group). It needs an Official Business Account; the number
          must not be in the WhatsApp Business app. For groups that already
          exist on someone's phone, use <b>Import an exported chat</b>.
        </div>
        {!data.accounts.length ? (
          <div className="callout warn small">
            Connect a WhatsApp Business number first (Settings → Channels →
            WhatsApp).
          </div>
        ) : (
          <>
            {data.accounts.length > 1 && (
              <label className="field">
                Number
                <select
                  value={acc}
                  onChange={(e) =>
                    setF({ ...f, channelAccountId: e.target.value })
                  }
                >
                  {data.accounts.map((a: Json) => (
                    <option key={a.id} value={a.id}>
                      {a.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              Group name
              <input
                maxLength={128}
                value={f.subject}
                onChange={(e) => setF({ ...f, subject: e.target.value })}
                placeholder="e.g. Fleet portal — HRP AI"
              />
            </label>
            <label className="field">
              Description (optional)
              <textarea
                rows={2}
                maxLength={2048}
                value={f.description}
                onChange={(e) => setF({ ...f, description: e.target.value })}
              />
            </label>
            <ModeChoice mode={f.mode} set={(mode) => setF({ ...f, mode })} />
          </>
        )}
      </div>
    </Modal>
  );
}

/** The .txt of an export, or the .txt inside its .zip (opened here; media files stay on this computer). */
/** The export: its chat text, and (for a .zip "with media") the media files by name. */
async function readExport(file: File) {
  if (/\.zip$/i.test(file.name) || file.type.includes("zip")) {
    const files = unzipSync(new Uint8Array(await file.arrayBuffer()));
    const txt = Object.entries(files)
      .filter(([n]) => /\.txt$/i.test(n))
      .sort((a, b) => b[1].length - a[1].length)[0];
    if (!txt) throw new Error("No chat .txt inside this .zip");
    const media = new Map<string, Uint8Array>();
    for (const [n, b] of Object.entries(files))
      if (n !== txt[0] && !n.endsWith("/") && b.length)
        media.set(n.split("/").pop()!, b);
    return { text: strFromU8(txt[1]), media };
  }
  return { text: await file.text(), media: new Map<string, Uint8Array>() };
}

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif",
  heic: "image/heic",
  opus: "audio/ogg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  mp3: "audio/mpeg",
  amr: "audio/amr",
  wav: "audio/wav",
  mp4: "video/mp4",
  mov: "video/quicktime",
  "3gp": "video/3gpp",
  pdf: "application/pdf",
  txt: "text/plain",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const MAX_FILE = 25 * 1024 * 1024;

function ImportChat({
  projectId,
  chat,
  onClose,
  onDone,
}: {
  projectId: string;
  chat: Json | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [f, setF] = useState({
    title: "",
    team: "",
    mode: "suggest",
    since: "all",
    sinceDate: "",
  });
  const [file, setFile] = useState<File | null>(null);
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Json | null>(null);
  const act = useAct();
  const qc = useQueryClient();
  return (
    <Modal
      title={
        chat ? `Newer export of “${chat.title}”` : "Import an exported chat"
      }
      onClose={onClose}
      footer={
        result ? (
          <button className="btn primary" onClick={onClose}>
            Done
          </button>
        ) : (
          <button
            className="btn primary"
            disabled={busy || !file || (!chat && !f.title.trim())}
            onClick={async () => {
              setBusy(true);
              const r = await act(async () => {
                const { text, media } = await readExport(file!);
                // the media the chat names, not yet uploaded with an earlier export
                const named = new Set(
                  [
                    ...text.matchAll(
                      /<attached:\s*([^>]+)>|([^\s/\\:]+\.[A-Za-z0-9]{2,5}) \(file attached\)/g,
                    ),
                  ].map((m) => (m[1] ?? m[2] ?? "").trim()),
                );
                const known = chat
                  ? new Set(
                      (
                        await get<{ names: string[] }>(
                          `/api/v1/projects/${projectId}/chats/${chat.id}/media-names`,
                        )
                      ).names,
                    )
                  : new Set<string>();
                const todo = [...media].filter(
                  ([n]) => named.has(n) && !known.has(n),
                );
                const uploaded: { name: string; fileId: string }[] = [];
                let skipped = 0;
                for (const [i, [name, bytes]] of todo.entries()) {
                  setProgress(`Uploading media ${i + 1} of ${todo.length}…`);
                  if (bytes.length > MAX_FILE) {
                    skipped++;
                    continue;
                  }
                  const ext = name.split(".").pop()!.toLowerCase();
                  try {
                    const f = await upload<{ id: string }>(
                      `/api/v1/files?object=project&id=${projectId}&name=${encodeURIComponent(name)}&description=${encodeURIComponent("From a WhatsApp chat export")}`,
                      new Blob([bytes as Uint8Array<ArrayBuffer>], {
                        type: MIME[ext] ?? "application/octet-stream",
                      }),
                    );
                    uploaded.push({ name, fileId: f.id });
                  } catch {
                    skipped++;
                  }
                }
                setProgress("Reading the chat…");
                const res = await post<Json>(
                  `/api/v1/projects/${projectId}/chats/import`,
                  {
                    chatId: chat?.id ?? null,
                    title: chat ? null : f.title.trim(),
                    mode: f.mode,
                    text,
                    teamNames: f.team
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                    offsetMinutes: -new Date().getTimezoneOffset(),
                    media: uploaded,
                    readSince:
                      f.since === "all"
                        ? null
                        : f.since === "custom"
                          ? f.sinceDate || null
                          : new Date(Date.now() - Number(f.since) * 86_400_000)
                              .toISOString()
                              .slice(0, 10),
                  },
                );
                return {
                  ...res,
                  uploaded: uploaded.length,
                  mediaSkipped: skipped,
                };
              });
              setBusy(false);
              setProgress("");
              if (r) {
                setResult(r);
                onDone();
                qc.invalidateQueries({
                  queryKey: ["project-chats", projectId],
                });
              }
            }}
          >
            {busy ? progress || "Reading…" : "Import"}
          </button>
        )
      }
    >
      <div className="modal-body stack">
        {result ? (
          <p>
            Read {result.read} messages ({date(result.from)} – {date(result.to)}
            ): <b>{result.added} new</b>
            {result.skipped ? `, ${result.skipped} already here` : ""}.
            {result.media
              ? ` ${result.media} photos, voice notes, videos and documents in the chat; ${result.uploaded} uploaded${result.mediaSkipped ? ` (${result.mediaSkipped} too large or failed — videos over 25 MB stay out)` : ""}.`
              : ""}{" "}
            The AI listens to the voice notes, looks at the photos and
            screenshots, reads the PDFs, then reads the chat and proposes tasks,
            bugs, requirements and calls — in a few minutes, or press{" "}
            <b>Read now</b>. Long chats are read a part at a time.
          </p>
        ) : (
          <>
            <ol className="small" style={{ margin: 0, paddingLeft: 18 }}>
              <li>
                On the phone, open the WhatsApp group or chat → ⋮ (or the name,
                on iPhone) → More → <b>Export chat</b> → <b>Include media</b>{" "}
                (or Without media, for the text only).
              </li>
              <li>
                Send the .zip to yourself (mail, Drive) and choose it below.
                Photos, screenshots, voice notes and PDFs are read too; each
                file up to 25 MB.
              </li>
              <li>
                Later, export again and use <b>Upload newer export</b>: only new
                messages are added.
              </li>
            </ol>
            {!chat && (
              <label className="field">
                Name of the chat
                <input
                  value={f.title}
                  onChange={(e) => setF({ ...f, title: e.target.value })}
                  placeholder="e.g. Fleet portal — client group"
                />
              </label>
            )}
            <label className="field">
              Export file (.zip or .txt)
              <input
                type="file"
                accept=".zip,.txt,text/plain,application/zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
            </label>
            <label className="field">
              Names in the chat who are on our side (comma-separated)
              <input
                value={f.team}
                onChange={(e) => setF({ ...f, team: e.target.value })}
                placeholder="Names as they appear in the chat; colleagues' names are matched already"
              />
            </label>
            <label className="field">
              Read the chat from
              <select
                value={f.since}
                onChange={(e) => setF({ ...f, since: e.target.value })}
              >
                <option value="all">The beginning (all of it)</option>
                <option value="365">The last 12 months</option>
                <option value="90">The last 3 months</option>
                <option value="30">The last 30 days</option>
                <option value="custom">A date…</option>
              </select>
              {f.since === "custom" && (
                <input
                  type="date"
                  value={f.sinceDate}
                  onChange={(e) => setF({ ...f, sinceDate: e.target.value })}
                />
              )}
              <small className="muted">
                Older messages are kept on the chat; only these are read for
                tasks.
              </small>
            </label>
            {!chat && (
              <ModeChoice mode={f.mode} set={(mode) => setF({ ...f, mode })} />
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

/** A suggestion in full: what the AI understood, and the messages, photos, voice notes and files behind it. */
function ProposalDetail({
  projectId,
  p,
  onClose,
  actions,
}: {
  projectId: string;
  p: Json;
  onClose: () => void;
  actions: React.ReactNode;
}) {
  const { data } = useQuery({
    queryKey: ["chat-proposal", p.id, p.message_ids?.length ?? 0],
    queryFn: () =>
      get<Json>(`/api/v1/projects/${projectId}/chat-proposals/${p.id}`),
  });
  const d = data ?? p;
  const msgs = (data?.messages ?? []) as Json[];
  const files = msgs.filter((m) => m.cited && m.file);
  const facts: [string, React.ReactNode][] = [
    [
      "Type",
      <span className={`chip ${KIND_CHIP[d.kind] ?? ""}`}>
        {KIND_LABEL[d.kind] ?? d.kind}
      </span>,
    ],
    [
      "Priority",
      <span className={`chip ${d.priority === "high" ? "bad" : ""}`}>
        {d.priority}
      </span>,
    ],
    ["Asked by", d.requested_by ?? "—"],
    [
      "In the chat",
      `${d.chat_title}${d.message_at ? ` · ${when(d.message_at)}` : ""}`,
    ],
    ...(d.due ? ([["Due", date(d.due)]] as [string, React.ReactNode][]) : []),
    ...(d.starts_at
      ? ([["Call at", when(d.starts_at)]] as [string, React.ReactNode][])
      : []),
    [
      "Found by",
      d.ai
        ? `AI · ${Math.round(Number(d.confidence) * 100)}% sure`
        : "keyword rules",
    ],
    ...(d.status !== "proposed"
      ? ([
          [
            "Status",
            d.status === "created"
              ? `Created${d.created_key ? ` · ${d.created_key}` : ""}`
              : "Dismissed",
          ],
        ] as [string, React.ReactNode][])
      : []),
  ];
  return (
    <Modal title={d.title} onClose={onClose} wide footer={actions}>
      <div className="modal-body stack">
        <table className="data small">
          <tbody>
            {facts.map(([k, v]) => (
              <tr key={k}>
                <th
                  style={{ width: 130, textAlign: "left", fontWeight: 500 }}
                  className="muted"
                >
                  {k}
                </th>
                <td>{v}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {d.detail && (
          <section>
            <h4 style={{ margin: "0 0 4px" }}>What it is</h4>
            <div style={{ whiteSpace: "pre-wrap" }}>{d.detail}</div>
          </section>
        )}
        {d.quote && (
          <section>
            <h4 style={{ margin: "0 0 4px" }}>In their words</h4>
            <div
              className="muted"
              style={{
                borderLeft: "3px solid var(--line)",
                paddingLeft: 8,
                whiteSpace: "pre-wrap",
              }}
            >
              “{d.quote}”
            </div>
          </section>
        )}
        {!data ? (
          <Spinner />
        ) : (
          <>
            {files.length > 0 && (
              <section>
                <h4 style={{ margin: "0 0 6px" }}>
                  Files from the chat ({files.length}){" "}
                  <span className="small muted">
                    — attached to the work when you create it
                  </span>
                </h4>
                <div
                  className="row"
                  style={{
                    gap: 10,
                    flexWrap: "wrap",
                    alignItems: "flex-start",
                  }}
                >
                  {files.map((m) => (
                    <div key={m.id} style={{ maxWidth: 300 }}>
                      <ChatFile f={m.file} />
                    </div>
                  ))}
                </div>
              </section>
            )}
            <section>
              <h4 style={{ margin: "0 0 6px" }}>The conversation</h4>
              {!msgs.length ? (
                <p className="muted small">
                  The messages behind this suggestion are no longer on the chat.
                </p>
              ) : (
                <div
                  className="stack"
                  style={{ gap: 6, maxHeight: "45vh", overflowY: "auto" }}
                >
                  {msgs.map((m) => (
                    <Bubble key={m.id} m={m} mark={m.cited} />
                  ))}
                </div>
              )}
              <p className="small muted" style={{ margin: "6px 0 0" }}>
                Highlighted: the messages it comes from. The rest is what was
                said around them.
              </p>
            </section>
          </>
        )}
      </div>
    </Modal>
  );
}

function Bubble({ m, mark }: { m: Json; mark?: boolean }) {
  return (
    <div
      style={{
        alignSelf: m.side === "team" ? "flex-end" : "flex-start",
        maxWidth: "85%",
        background:
          m.side === "team" ? "var(--accent-soft)" : "var(--bg-2, #f4f5f7)",
        borderRadius: 10,
        padding: "6px 10px",
        outline: mark ? "2px solid var(--accent)" : undefined,
      }}
    >
      <div className="small muted">
        {m.sender} · {when(m.at)}
      </div>
      {m.file && (
        <div style={{ margin: "4px 0" }}>
          <ChatFile f={m.file} />
        </div>
      )}
      <div style={{ whiteSpace: "pre-wrap" }}>{m.body}</div>
    </div>
  );
}

/** A chat's photo, voice note, video or document: shown or played where it can be, else a download. */
function ChatFile({ f }: { f: Json }) {
  const mime = String(f.mime ?? "");
  if (mime.startsWith("image/") && !/heic/.test(mime))
    return (
      <a href={f.url} target="_blank" rel="noreferrer" title={f.name}>
        <img
          src={f.url}
          alt={f.name}
          loading="lazy"
          style={{
            maxWidth: "100%",
            maxHeight: 260,
            borderRadius: 6,
            display: "block",
          }}
        />
      </a>
    );
  if (mime.startsWith("audio/"))
    return (
      <div>
        <audio
          controls
          preload="none"
          src={f.url}
          style={{ maxWidth: "100%" }}
        />
        <div className="small muted">🎤 {f.name}</div>
      </div>
    );
  if (mime.startsWith("video/"))
    return (
      <div>
        <video
          controls
          preload="metadata"
          src={f.url}
          style={{ maxWidth: "100%", maxHeight: 260, borderRadius: 6 }}
        />
        <div className="small muted">{f.name}</div>
      </div>
    );
  return (
    <a href={f.downloadUrl} className="small" title={f.name}>
      📄 {f.name}
      {f.size ? ` · ${Math.max(1, Math.round(Number(f.size) / 1024))} KB` : ""}
    </a>
  );
}

function ChatView({
  projectId,
  chat,
  canManage,
  onClose,
  onChanged,
}: {
  projectId: string;
  chat: Json;
  canManage: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { data } = useQuery({
    queryKey: ["project-chats", projectId, chat.id, "messages"],
    queryFn: () =>
      get<Json[]>(`/api/v1/projects/${projectId}/chats/${chat.id}/messages`),
  });
  const act = useAct();
  return (
    <Modal
      title={chat.title}
      onClose={onClose}
      wide
      footer={
        canManage ? (
          <button
            className="btn danger"
            onClick={async () => {
              if (
                !window.confirm(
                  `Take “${chat.title}” off the project? Its suggestions go too; work already created stays.`,
                )
              )
                return;
              if (
                (await act(
                  () => del(`/api/v1/projects/${projectId}/chats/${chat.id}`),
                  "Removed",
                )) !== null
              )
                (onChanged(), onClose());
            }}
          >
            Take off the project
          </button>
        ) : null
      }
    >
      <div className="modal-body">
        {!data ? (
          <Spinner />
        ) : !data.length ? (
          <p className="muted small">No messages yet.</p>
        ) : (
          <div
            className="stack"
            style={{ gap: 6, maxHeight: "60vh", overflowY: "auto" }}
          >
            {[...data].reverse().map((m) => (
              <Bubble key={m.id} m={m} />
            ))}
          </div>
        )}
      </div>
    </Modal>
  );
}
