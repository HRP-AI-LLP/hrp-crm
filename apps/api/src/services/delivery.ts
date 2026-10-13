/**
 * Deliveries and installations.
 *
 *   planned / packed → dispatched (stock leaves) → delivered (customer has it; order fulfilment)
 *                   ↘ failed (goods back in stock, re-reserved) / cancelled
 *
 *   installation: scheduled → in_progress → completed (order → installed)  ↔ on_hold (exception)
 *
 * Customers confirm a delivery or sign off an installation from a link (name, rating, signature).
 */
import { badRequest, notFound } from '../lib/errors';
import type { Env } from '../env';
import { saveFile, sniffType } from './files';
import { LINE_DOCS, readLines } from './lines';
import { markInstalled, returnLines, shipLines } from './orders';
import { createRecord, loadRow, type RecordCtx, type RecordEvent, readRowSystem, toDto } from './records';

const OPEN_SHIP = ['planned', 'packed'];

async function shipmentLines(ctx: RecordCtx, shipmentId: string) {
  return ctx.tx.query<{ id: string; order_line_id: string; quantity: string; name: string; unit: string | null; product_id: string | null; hsn_sac: string | null }>(
    `select sl.id, sl.order_line_id, sl.quantity, ol.name, ol.unit, ol.product_id, ol.hsn_sac
       from shipment_lines sl join sales_order_lines ol on ol.tenant_id = sl.tenant_id and ol.id = sl.order_line_id
      where sl.tenant_id = $1 and sl.shipment_id = $2 order by ol.position`,
    [ctx.tenantId, shipmentId],
  );
}

export async function getShipment(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'shipment', id, 'read');
  return { shipment: { ...toDto(obj, row, ctx.principal.permissions), share_token: row.share_token ?? null, confirmed_at: row.confirmed_at ?? null, confirmed_by: row.confirmed_by ?? null, customer_feedback: row.customer_feedback ?? null }, lines: (await shipmentLines(ctx, id)).map((l) => ({ ...l, quantity: Number(l.quantity) })) };
}

export interface PlanInput {
  lines?: { orderLineId: string; quantity: number }[] | null;
  plannedDate?: string | null;
  carrier?: string | null;
  vehicleNo?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  notes?: string | null;
  ownerId?: string | null;
}

/** Plans a delivery for (part of) a confirmed order; quantities can't exceed what is still unshipped. */
export async function planShipment(ctx: RecordCtx, orderId: string, input: PlanInput) {
  const { row: o } = await loadRow(ctx, 'sales_order', orderId, 'read');
  if (!['confirmed', 'in_production', 'ready', 'dispatched', 'delivered'].includes(String(o.status))) throw badRequest('Confirm the order before planning deliveries');
  const lines = await readLines(ctx, LINE_DOCS.sales_order!, orderId);
  const planned = await ctx.tx.query<{ order_line_id: string; q: string }>(
    `select sl.order_line_id, sum(sl.quantity) q from shipment_lines sl join shipments s on s.tenant_id = sl.tenant_id and s.id = sl.shipment_id
      where sl.tenant_id = $1 and s.sales_order_id = $2 and s.status = any($3) and s.deleted_at is null group by sl.order_line_id`,
    [ctx.tenantId, orderId, OPEN_SHIP],
  );
  const pending = new Map(planned.map((p) => [p.order_line_id, Number(p.q)]));
  const avail = new Map(lines.map((l) => [l.id, Number(l.quantity) - Number(l.shippedQty ?? 0) - (pending.get(l.id) ?? 0)]));
  const want = input.lines?.length ? input.lines : lines.map((l) => ({ orderLineId: l.id, quantity: Math.max(0, avail.get(l.id) ?? 0) })).filter((l) => l.quantity > 0);
  if (!want.length) throw badRequest('Everything on this order is already planned or shipped');
  for (const w of want) {
    const a = avail.get(w.orderLineId);
    if (a === undefined) throw badRequest('A line does not belong to this order');
    if (!(w.quantity > 0)) throw badRequest('Quantities must be positive');
    if (w.quantity > a + 1e-9) throw badRequest(`${lines.find((l) => l.id === w.orderLineId)?.name}: only ${a} left to plan`);
  }
  const n = await ctx.tx.one<{ n: string }>(`select count(*) + 1 as n from shipments where tenant_id = $1 and sales_order_id = $2`, [ctx.tenantId, orderId]);
  const r = await createRecord(ctx, 'shipment', {
    name: `${o.name} — delivery ${n?.n ?? 1}`,
    account_id: o.account_id ?? null,
    planned_date: input.plannedDate ?? null,
    warehouse_id: o.warehouse_id ?? null,
    delivery_address: o.site_address ?? null,
    carrier: input.carrier ?? null,
    vehicle_no: input.vehicleNo ?? null,
    driver_name: input.driverName ?? null,
    driver_phone: input.driverPhone ?? null,
    notes: input.notes ?? null,
    ...(input.ownerId ? { owner_id: input.ownerId } : {}),
  });
  await ctx.tx.query(`update shipments set sales_order_id = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, orderId]);
  for (const w of want) await ctx.tx.query(`insert into shipment_lines (tenant_id, shipment_id, order_line_id, quantity) values ($1,$2,$3,$4)`, [ctx.tenantId, r.record.id, w.orderLineId, w.quantity]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'sales_order',$3)`, [ctx.tenantId, `Delivery ${r.record.shipment_number} planned`, orderId]);
  return { id: r.record.id, events: r.events };
}

async function lockShipment(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'shipment', id, 'update', true);
  if (!row.sales_order_id) throw badRequest('This delivery is not linked to an order');
  const lines = await shipmentLines(ctx, id);
  const qty = Object.fromEntries(lines.map((l) => [l.order_line_id, Number(l.quantity)]));
  const ref = { object: 'shipment', id, label: `Delivery ${row.shipment_number}` };
  return { row, qty, ref, orderId: String(row.sales_order_id) };
}

async function setShipmentStatus(ctx: RecordCtx, id: string, from: string, to: string, extra: Record<string, unknown> = {}): Promise<RecordEvent[]> {
  const sets = ['status = $3', ...Object.keys(extra).map((k, i) => `${k} = $${i + 4}`)];
  await ctx.tx.query(`update shipments set ${sets.join(', ')} where tenant_id = $1 and id = $2`, [ctx.tenantId, id, to, ...Object.values(extra)]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id, metadata) values ($1,'stage_change',$2,'shipment',$3,$4)`, [ctx.tenantId, `Delivery ${to}`, id, JSON.stringify({ from, to })]);
  return [{ objectKey: 'shipment', recordId: id, kind: 'updated', changes: { status: [from, to] } }];
}

export async function packShipment(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'shipment', id, 'update', true);
  if (row.status !== 'planned') throw badRequest('Only planned deliveries can be packed');
  return setShipmentStatus(ctx, id, 'planned', 'packed');
}

/** Goods leave: stock out against the order's reservation, order → dispatched. */
export async function dispatchShipment(ctx: RecordCtx, id: string, details: { vehicleNo?: string | null; driverName?: string | null; driverPhone?: string | null; trackingRef?: string | null }) {
  const { row, qty, ref, orderId } = await lockShipment(ctx, id);
  if (!OPEN_SHIP.includes(String(row.status))) throw badRequest('Only planned or packed deliveries can be dispatched');
  const events = await shipLines(ctx, orderId, qty, ref, (row.warehouse_id as string | null) ?? null, 'ship');
  const extra: Record<string, unknown> = { dispatched_at: new Date().toISOString() };
  if (details.vehicleNo) extra.vehicle_no = details.vehicleNo;
  if (details.driverName) extra.driver_name = details.driverName;
  if (details.driverPhone) extra.driver_phone = details.driverPhone;
  if (details.trackingRef) extra.tracking_ref = details.trackingRef;
  events.push(...(await setShipmentStatus(ctx, id, String(row.status), 'dispatched', extra)));
  return events;
}

/** Customer has the goods: order fulfilment advances (delivered when everything arrived). */
export async function deliverShipment(ctx: RecordCtx, id: string, receivedBy: string | null, notes: string | null, system = false) {
  const { row, qty, ref, orderId } = system ? await systemLock(ctx, id) : await lockShipment(ctx, id);
  if (row.status !== 'dispatched') throw badRequest('Dispatch the delivery first');
  const events = await shipLines(ctx, orderId, qty, ref, null, 'deliver');
  events.push(...(await setShipmentStatus(ctx, id, 'dispatched', 'delivered', { delivered_at: new Date().toISOString(), received_by: receivedBy, ...(notes ? { notes } : {}) })));
  const o = await readRowSystem(ctx, 'sales_order', orderId);
  if (o?.owner_id) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'delivery',$3,$4,$5)`, [
      ctx.tenantId, o.owner_id, `Delivered: ${row.shipment_number}`, `${o.name}${receivedBy ? ` · received by ${receivedBy}` : ''}`, `/o/shipment/${id}`,
    ]);
  }
  return events;
}

async function systemLock(ctx: RecordCtx, id: string) {
  const row = await ctx.tx.one<Record<string, unknown>>(`select * from shipments where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, id]);
  if (!row?.sales_order_id) throw notFound();
  const lines = await shipmentLines(ctx, id);
  return { row, qty: Object.fromEntries(lines.map((l) => [l.order_line_id, Number(l.quantity)])), ref: { object: 'shipment', id, label: `Delivery ${row.shipment_number}` }, orderId: String(row.sales_order_id) };
}

/** Delivery did not happen: goods return to stock (re-reserved) so the order can be re-planned. */
export async function failShipment(ctx: RecordCtx, id: string, reason: string) {
  const { row, qty, ref, orderId } = await lockShipment(ctx, id);
  if (row.status !== 'dispatched') throw badRequest('Only dispatched deliveries can fail');
  await returnLines(ctx, orderId, qty, ref, (row.warehouse_id as string | null) ?? null, reason);
  const events = await setShipmentStatus(ctx, id, 'dispatched', 'failed', { exception_reason: reason });
  const o = await readRowSystem(ctx, 'sales_order', orderId);
  const notify = new Set([o?.owner_id, row.owner_id].filter((x): x is string => !!x));
  for (const u of notify) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'delivery',$3,$4,$5)`, [ctx.tenantId, u, `Delivery failed: ${row.shipment_number}`, reason, `/o/shipment/${id}`]);
  }
  return events;
}

export async function cancelShipment(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'shipment', id, 'update', true);
  if (!OPEN_SHIP.includes(String(row.status))) throw badRequest('Only planned or packed deliveries can be cancelled');
  return setShipmentStatus(ctx, id, String(row.status), 'cancelled');
}

// ------------------------------------------------------------------------------- installations
export interface ScheduleInput {
  orderId?: string | null;
  shipmentId?: string | null;
  name?: string | null;
  start: string;
  end?: string | null;
  technicianId: string;
  crewIds?: string[];
  siteAddress?: string | null;
  contactPhone?: string | null;
  checklist?: string[] | null;
}

const DEFAULT_CHECKLIST = ['Check items against the order', 'Assemble and install', 'Level, align and fix securely', 'Clean the site and remove packing', 'Demonstrate use and care to the customer'];

export async function scheduleInstallation(ctx: RecordCtx, input: ScheduleInput) {
  let order: Record<string, unknown> | null = null;
  if (input.orderId) order = (await loadRow(ctx, 'sales_order', input.orderId, 'read')).row;
  const tech = await ctx.tx.one<{ id: string }>(`select id from users where tenant_id = $1 and id = $2 and status = 'active'`, [ctx.tenantId, input.technicianId]);
  if (!tech) throw badRequest('Choose an active technician');
  const tpl = await ctx.tx.one<{ c: string[] | null }>(`select settings -> 'installation' -> 'checklist' as c from tenants where id = $1`, [ctx.tenantId]);
  const items = (input.checklist?.length ? input.checklist : (tpl?.c ?? DEFAULT_CHECKLIST)).slice(0, 30).map((label) => ({ label: String(label).slice(0, 200), done: false }));
  const r = await createRecord(ctx, 'installation', {
    name: input.name || (order ? `Installation — ${order.name}` : 'Installation'),
    sales_order_id: input.orderId ?? null,
    shipment_id: input.shipmentId ?? null,
    account_id: order?.account_id ?? null,
    scheduled_start: input.start,
    scheduled_end: input.end ?? null,
    site_address: input.siteAddress ?? order?.site_address ?? null,
    contact_phone: input.contactPhone ?? null,
    owner_id: input.technicianId,
  });
  const crew = [...new Set((input.crewIds ?? []).filter((x) => x !== input.technicianId))].slice(0, 10);
  await ctx.tx.query(`update installations set checklist = $3, crew_ids = $4 where tenant_id = $1 and id = $2`, [ctx.tenantId, r.record.id, JSON.stringify(items), crew]);
  await shareWithCrew(ctx, r.record.id, crew, r.record.title);
  if (input.orderId) await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id) values ($1,'system',$2,'sales_order',$3)`, [ctx.tenantId, `Installation ${r.record.job_number} scheduled`, input.orderId]);
  return { id: r.record.id, events: r.events };
}

/** Crew members see and update the job through record shares; each gets a notification. */
async function shareWithCrew(ctx: RecordCtx, id: string, crew: string[], title: string) {
  for (const u of crew) {
    await ctx.tx.query(
      `insert into record_shares (tenant_id, object_key, record_id, user_id, access, created_by) values ($1,'installation',$2,$3,'edit',$4) on conflict do nothing`,
      [ctx.tenantId, id, u, ctx.principal.user.id],
    );
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'assignment',$3,'You are on the crew',$4)`, [ctx.tenantId, u, `Installation: ${title}`, `/o/installation/${id}`]);
  }
}

export async function setCrew(ctx: RecordCtx, id: string, crewIds: string[]) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  const crew = [...new Set(crewIds.filter((x) => x !== row.owner_id))].slice(0, 10);
  const prev = new Set((row.crew_ids as string[]) ?? []);
  await ctx.tx.query(`update installations set crew_ids = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, crew]);
  await ctx.tx.query(`delete from record_shares where tenant_id = $1 and object_key = 'installation' and record_id = $2 and user_id is not null and not (user_id = any($3::uuid[]))`, [ctx.tenantId, id, crew]);
  await shareWithCrew(ctx, id, crew.filter((u) => !prev.has(u)), String(row.name));
  return { crew };
}

export async function saveChecklist(ctx: RecordCtx, id: string, items: { label: string; done: boolean }[]) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  if (['completed', 'cancelled'].includes(String(row.status))) throw badRequest('This job is closed');
  await ctx.tx.query(`update installations set checklist = $3 where tenant_id = $1 and id = $2`, [ctx.tenantId, id, JSON.stringify(items.slice(0, 30))]);
  return { ok: true };
}

async function setJobStatus(ctx: RecordCtx, id: string, from: string, to: string, extra: Record<string, unknown> = {}): Promise<RecordEvent[]> {
  const sets = ['status = $3', ...Object.keys(extra).map((k, i) => `${k} = $${i + 4}`)];
  await ctx.tx.query(`update installations set ${sets.join(', ')} where tenant_id = $1 and id = $2`, [ctx.tenantId, id, to, ...Object.values(extra)]);
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, related_object, related_id, metadata) values ($1,'stage_change',$2,'installation',$3,$4)`, [
    ctx.tenantId, `Installation ${to.replace(/_/g, ' ')}`, id, JSON.stringify({ from, to }),
  ]);
  return [{ objectKey: 'installation', recordId: id, kind: 'updated', changes: { status: [from, to] } }];
}

export async function startJob(ctx: RecordCtx, id: string) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  if (!['scheduled', 'on_hold'].includes(String(row.status))) throw badRequest('This job cannot be started');
  return setJobStatus(ctx, id, String(row.status), 'in_progress', { started_at: row.started_at ?? new Date().toISOString(), issue_type: null, issue_notes: null });
}

export async function holdJob(ctx: RecordCtx, id: string, issueType: string, notes: string) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  if (!['scheduled', 'in_progress'].includes(String(row.status))) throw badRequest('This job cannot be put on hold');
  const events = await setJobStatus(ctx, id, String(row.status), 'on_hold', { issue_type: issueType, issue_notes: notes });
  // the order owner / coordinator hears about exceptions straight away
  const o = row.sales_order_id ? await readRowSystem(ctx, 'sales_order', String(row.sales_order_id)) : null;
  for (const u of new Set([o?.owner_id].filter((x): x is string => !!x && x !== ctx.principal.user.id))) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'installation',$3,$4,$5)`, [
      ctx.tenantId, u, `Installation on hold: ${row.job_number}`, `${issueType.replace(/_/g, ' ')} — ${notes}`, `/o/installation/${id}`,
    ]);
  }
  return events;
}

export async function completeJob(ctx: RecordCtx, id: string, notes: string | null) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  if (row.status !== 'in_progress') throw badRequest('Start the job before completing it');
  const open = ((row.checklist as { label: string; done: boolean }[]) ?? []).filter((c) => !c.done);
  if (open.length) throw badRequest(`Finish the checklist first: ${open.map((c) => c.label).join(', ')}`);
  const events = await setJobStatus(ctx, id, 'in_progress', 'completed', { completed_at: new Date().toISOString(), completion_notes: notes });
  if (row.sales_order_id) events.push(...(await markInstalled(ctx, String(row.sales_order_id))));
  return events;
}

export async function cancelJob(ctx: RecordCtx, id: string, reason: string) {
  const { row } = await loadRow(ctx, 'installation', id, 'update', true);
  if (['completed', 'cancelled'].includes(String(row.status))) throw badRequest('This job is closed');
  return setJobStatus(ctx, id, String(row.status), 'cancelled', { issue_notes: reason });
}

export async function getInstallation(ctx: RecordCtx, id: string) {
  const { obj, row } = await loadRow(ctx, 'installation', id, 'read');
  const crew = await ctx.tx.query<{ id: string; full_name: string }>(`select id, full_name from users where tenant_id = $1 and id = any($2::uuid[])`, [ctx.tenantId, (row.crew_ids as string[]) ?? []]);
  return {
    installation: { ...toDto(obj, row, ctx.principal.permissions), checklist: row.checklist ?? [], crew, share_token: row.share_token ?? null, confirmed_at: row.confirmed_at ?? null, confirmed_by: row.confirmed_by ?? null, customer_feedback: row.customer_feedback ?? null },
  };
}

// ------------------------------------------------------------------------------- customer links
/** Public view of a delivery or installation (no internal fields). */
export async function publicJob(ctx: RecordCtx, kind: 'shipment' | 'installation', id: string) {
  const row = await ctx.tx.one<Record<string, any>>(`select * from ${kind === 'shipment' ? 'shipments' : 'installations'} where tenant_id = $1 and id = $2 and deleted_at is null`, [ctx.tenantId, id]);
  if (!row) throw notFound();
  const company = await ctx.tx.one<{ name: string; settings: Record<string, any> }>(`select name, settings from tenants where id = $1`, [ctx.tenantId]);
  const base = {
    kind,
    number: kind === 'shipment' ? row.shipment_number : row.job_number,
    title: row.name,
    status: row.status,
    company: company?.settings?.company?.legalName || company?.name,
    confirmedAt: row.confirmed_at,
    confirmedBy: row.confirmed_by,
    rating: row.customer_rating,
  };
  if (kind === 'shipment') {
    return {
      ...base,
      plannedDate: row.planned_date,
      dispatchedAt: row.dispatched_at,
      deliveredAt: row.delivered_at,
      address: row.delivery_address,
      carrier: row.carrier,
      vehicleNo: row.vehicle_no,
      driverName: row.driver_name,
      driverPhone: row.driver_phone,
      items: (await shipmentLines(ctx, id)).map((l) => ({ name: l.name, quantity: Number(l.quantity), unit: l.unit })),
    };
  }
  const tech = row.owner_id ? await ctx.tx.one<{ full_name: string }>(`select full_name from users where tenant_id = $1 and id = $2`, [ctx.tenantId, row.owner_id]) : null;
  return { ...base, scheduledStart: row.scheduled_start, scheduledEnd: row.scheduled_end, completedAt: row.completed_at, address: row.site_address, technician: tech?.full_name ?? null, checklist: row.checklist ?? [], notes: row.completion_notes };
}

/** Customer confirmation from the link: name, rating, optional feedback and a drawn signature (PNG). */
export async function confirmByCustomer(
  ctx: RecordCtx,
  env: Env,
  kind: 'shipment' | 'installation',
  id: string,
  input: { name: string; rating?: number | null; feedback?: string | null; signature?: string | null },
): Promise<RecordEvent[]> {
  const table = kind === 'shipment' ? 'shipments' : 'installations';
  const row = await ctx.tx.one<Record<string, any>>(`select * from ${table} where tenant_id = $1 and id = $2 and deleted_at is null for update`, [ctx.tenantId, id]);
  if (!row) throw notFound();
  if (row.confirmed_at) throw badRequest('This has already been confirmed. Thank you!');
  const ok = kind === 'shipment' ? ['dispatched', 'delivered'].includes(row.status) : row.status === 'completed';
  if (!ok) throw badRequest(kind === 'shipment' ? 'This delivery is not on its way yet' : 'The installation is not complete yet');
  let events: RecordEvent[] = [];
  if (kind === 'shipment' && row.status === 'dispatched') events = await deliverShipment(ctx, id, input.name, null, true);
  await ctx.tx.query(`update ${table} set confirmed_at = now(), confirmed_by = $3, customer_rating = $4, customer_feedback = $5 where tenant_id = $1 and id = $2`, [
    ctx.tenantId, id, input.name, input.rating ?? null, input.feedback ?? null,
  ]);
  if (input.signature && env.FILES) {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(input.signature);
    if (m && m[1]!.length < 700_000) {
      const bytes = Uint8Array.from(atob(m[1]!), (c) => c.charCodeAt(0));
      // only a real PNG is kept as a signature, whatever the data URL claims
      if (sniffType(bytes, 'signature.png') !== 'image/png') throw badRequest('The signature must be a PNG image');
      await saveFile(ctx, env, { objectKey: kind, recordId: id, name: `signature-${input.name.replace(/[^A-Za-z0-9]+/g, '-').slice(0, 40)}.png`, bytes, kind: 'signature', description: `Signed by ${input.name}` }, { system: true });
    }
  }
  await ctx.tx.query(`insert into activities (tenant_id, kind, subject, body, direction, related_object, related_id, metadata) values ($1,'system',$2,$3,'in',$4,$5,$6)`, [
    ctx.tenantId, `${kind === 'shipment' ? 'Delivery' : 'Installation'} confirmed by ${input.name}`, input.feedback ?? null, kind, id, JSON.stringify({ rating: input.rating ?? null }),
  ]);
  if (row.owner_id) {
    await ctx.tx.query(`insert into notifications (tenant_id, user_id, kind, title, body, link) values ($1,$2,'feedback',$3,$4,$5)`, [
      ctx.tenantId, row.owner_id, `${input.name} confirmed ${kind === 'shipment' ? row.shipment_number : row.job_number}`, input.rating ? `${'★'.repeat(input.rating)}${input.feedback ? ` — ${input.feedback}` : ''}` : input.feedback ?? null, `/o/${kind}/${id}`,
    ]);
  }
  return events;
}
