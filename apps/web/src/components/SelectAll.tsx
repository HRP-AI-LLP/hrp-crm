/** Header checkbox: selects or clears every row shown (after the search filter); half-ticked when some are. */
export function SelectAll({ ids, sel, setSel }: { ids: string[]; sel: Set<string>; setSel: (s: Set<string>) => void }) {
  const n = ids.filter((id) => sel.has(id)).length;
  return (
    <input
      type="checkbox"
      aria-label={n === ids.length && n ? 'Clear all' : 'Select all'}
      title={n === ids.length && n ? 'Clear all' : `Select all ${ids.length}`}
      disabled={!ids.length}
      checked={!!ids.length && n === ids.length}
      ref={(el) => {
        if (el) el.indeterminate = n > 0 && n < ids.length;
      }}
      onChange={() => setSel(n === ids.length ? new Set([...sel].filter((id) => !ids.includes(id))) : new Set([...sel, ...ids]))}
    />
  );
}
