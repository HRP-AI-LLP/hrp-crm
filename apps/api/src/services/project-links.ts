/** Frees project time, expenses and milestones from an invoice that was deleted or cancelled. */
import type { Tx } from '../lib/db';

export async function releaseInvoice(tx: Tx, tenantId: string, invoiceId: string) {
  await tx.query(`update time_entries set status = 'approved', invoice_id = null where tenant_id = $1 and invoice_id = $2 and status = 'invoiced'`, [tenantId, invoiceId]);
  await tx.query(`update expenses set invoice_id = null where tenant_id = $1 and invoice_id = $2`, [tenantId, invoiceId]);
  await tx.query(`update project_milestones set invoice_id = null where tenant_id = $1 and invoice_id = $2`, [tenantId, invoiceId]);
}
