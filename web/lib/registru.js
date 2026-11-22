// Logbook maths on the client: counts an entry the server has not stored yet (in flight or in the
// offline outbox) the same way server/store/registru.mjs summarize() does.
export const COUNTED = { 'nastere-vaginala': 'vaginale', cezariana: 'cezariene' };
export const MILESTONES = [1, 10, 25, 50, 100, 250, 500, 1000];

// item = { id, body: { row, rol, n, date, copii, nota }, createdAt }
export function withPending(summary, item, today) {
  const b = item.body;
  const row = summary.rows.find((r) => r.id === b.row);
  const rowId = row ? row.id : b.row;
  const rol = b.rol || 'efectuat';
  const n = Number(b.n) || 1;
  const counted = rol === 'efectuat' && COUNTED[rowId];
  const copii = counted ? Number(b.copii ?? n) : 0;
  const date = b.date || today;
  const copiiSum = { ...summary.copii };
  if (counted && copii > 0) {
    copiiSum.total += copii;
    copiiSum[COUNTED[rowId]] += copii;
    if (!copiiSum.primul || date < copiiSum.primul) copiiSum.primul = date;
  }
  const rows = row
    ? summary.rows.map((r) => (r.id === rowId ? { ...r, [rol]: r[rol] + n } : r))
    : [...summary.rows, { id: rowId, nume: rowId, barem: '', tinta: null, efectuat: 0, ajutat: 0, observat: 0, [rol]: n }];
  const entry = { id: item.id, date, row: rowId, rol, n, copii, nota: b.nota || '', createdAt: item.createdAt, pending: true };
  return {
    ...summary,
    copii: copiiSum,
    rows,
    entries: [entry, ...summary.entries].sort((a, b) => b.date.localeCompare(a.date)),
    urmatorulPrag: MILESTONES.find((m) => m > copiiSum.total) ?? null,
  };
}

// The milestone crossed when the total goes from `before` to `after`, or null.
export const milestoneCrossed = (before, after) => MILESTONES.filter((m) => before < m && after >= m).at(-1) ?? null;
