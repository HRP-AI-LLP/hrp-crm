/**
 * An "Export PDF" button above every data table in the app (`table.data`), present and future: the shell
 * starts this once. A table opts out with data-export="off" (e.g. record lists, which export every
 * matching row from the server instead of the rows on screen) and can name its report with
 * data-export-title. The buttons live outside React's tree and are tidied when their table goes.
 */
import { exportReportPdf, readTable, titleFor } from './table-pdf';

type Bar = HTMLDivElement & { __table?: HTMLTableElement };
const BAR = 'tbl-export';

function hasRows(t: HTMLTableElement) {
  return Array.from(t.tBodies).some((b) => Array.from(b.rows).some((r) => r.cells.length > 1 || (r.cells[0] && r.cells[0].colSpan <= 1)));
}

function wants(t: HTMLTableElement) {
  return t.isConnected && t.getAttribute('data-export') !== 'off' && !t.closest('[data-export="off"], .qdoc, .qdoc-html, .print-only') && hasRows(t);
}

function makeBar(t: HTMLTableElement): Bar {
  const bar = document.createElement('div') as Bar;
  bar.className = BAR;
  bar.__table = t;
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'btn ghost sm';
  b.title = 'Download this table as a PDF report';
  b.textContent = '⤓ Export PDF';
  b.addEventListener('click', async () => {
    const table = bar.__table!;
    b.disabled = true;
    b.textContent = 'Preparing PDF…';
    try {
      const data = readTable(table);
      const shown = table.getAttribute('data-export-note');
      await exportReportPdf({ title: titleFor(table), subtitle: shown, ...data });
    } catch (e) {
      // the app's toasts live in React; a plain alert would block the page, so report in the button
      b.textContent = 'PDF failed — try again';
      console.error('PDF export failed', e);
      setTimeout(() => (b.textContent = '⤓ Export PDF'), 4000);
      return;
    } finally {
      b.disabled = false;
    }
    b.textContent = '⤓ Export PDF';
  });
  bar.appendChild(b);
  return bar;
}

function sync() {
  // tidy bars whose table went away or moved
  document.querySelectorAll<Bar>(`.${BAR}`).forEach((bar) => {
    const t = bar.__table;
    if (!t || !wants(t) || bar.nextElementSibling !== t) bar.remove();
  });
  document.querySelectorAll<HTMLTableElement>('table.data').forEach((t) => {
    if (!wants(t)) return;
    const prev = t.previousElementSibling as Bar | null;
    if (prev?.classList.contains(BAR) && prev.__table === t) return;
    t.parentElement?.insertBefore(makeBar(t), t);
  });
}

let started = false;
export function startTablePdfButtons() {
  if (started) return;
  started = true;
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      sync();
    });
  };
  // our own bars are added under observation too: sync() is idempotent, so that settles at once
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  schedule();
}
