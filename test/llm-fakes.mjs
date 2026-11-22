// In-memory fakes for the assistant's unit tests. They copy the shapes of the real services as A1 and A2 built
// them: ids, thrown error codes, field names.
const fold = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const httpError = (status, message) => Object.assign(new Error(message), { status });

export function fakeRegistru() {
  const rows = [
    { id: 'nastere-vaginala', nume: 'Naștere vaginală', barem: '50', tinta: 50 },
    { id: 'cezariana', nume: 'Cezariană', barem: '20', tinta: 20 },
  ];
  const entries = [];
  let seq = 0;
  const counted = (e) => e.rol === 'efectuat' && (e.row === 'nastere-vaginala' || e.row === 'cezariana');
  const rowFor = (name) => {
    let row = rows.find((r) => r.id === name || fold(r.nume) === fold(name));
    if (!row) { row = { id: fold(name).replace(/[^a-z0-9]+/g, '-'), nume: name, barem: '', tinta: null }; rows.push(row); }
    return row;
  };
  return {
    summary() {
      const count = (rowId, rol) => entries.filter((e) => e.row === rowId && e.rol === rol).reduce((a, e) => a + e.n, 0);
      const sum = (rowId) => entries.filter((e) => e.row === rowId).reduce((a, e) => a + e.copii, 0);
      return {
        copii: { total: entries.reduce((a, e) => a + e.copii, 0), vaginale: sum('nastere-vaginala'), cezariene: sum('cezariana'), primul: entries.at(0)?.date ?? null },
        rows: rows.map((r) => ({ ...r, efectuat: count(r.id, 'efectuat'), ajutat: count(r.id, 'ajutat'), observat: count(r.id, 'observat') })),
        entries: [...entries].reverse(),
        urmatorulPrag: null,
      };
    },
    addEntry({ row, rol = 'efectuat', n = 1, date, copii, nota = '' }) {
      if (date > '2030') throw httpError(400, 'data_in_viitor');
      const entry = { id: `e${++seq}`, date, row: rowFor(row).id, rol, n, copii: 0, nota, createdAt: seq };
      entry.copii = counted(entry) ? (copii ?? n) : 0;
      entries.push(entry);
      return entry;
    },
    updateEntry(id, patch) {
      const e = entries.find((x) => x.id === id);
      if (!e) throw httpError(404, 'negasit');
      Object.assign(e, patch, patch.row ? { row: rowFor(patch.row).id } : {});
      e.copii = counted(e) ? (patch.copii ?? e.n) : 0;
      return e;
    },
    deleteEntry(id) {
      const i = entries.findIndex((x) => x.id === id);
      if (i < 0) throw httpError(404, 'negasit');
      entries.splice(i, 1);
      return { ok: true };
    },
    addRow: ({ nume, barem }) => Object.assign(rowFor(nume), { barem }),
    exportText: () => '',
  };
}

export function fakeMemorie(pages = {}) {
  const store = new Map(Object.entries(pages));
  const read = (pagina) => {
    if (!store.has(pagina)) throw httpError(404, 'negasit');
    return { pagina, titlu: pagina, markdown: store.get(pagina), updatedAt: 0 };
  };
  return {
    list: () => [...store.keys()].map((pagina) => ({ pagina, titlu: pagina, updatedAt: 0, bytes: store.get(pagina).length })),
    read,
    write: (pagina, markdown) => { store.set(pagina, markdown); return read(pagina); },
    store,
  };
}

/** `missing`: one { id, unit } or a list of them, in plan order. A unit stops being missing once it is saved. */
export function fakeLessons({ missing = null } = {}) {
  const saved = {};
  const excluded = [];
  return {
    saved,
    excluded,
    status: () => ({
      urmatoarea: { id: '14-1', ghid: { nr: '14', titlu: 'Anestezia în obstetrică' }, k: 1, n: 5, titlu: 'Analgezia la naștere', scrisa: true, minute: 7 },
      progres: [{ nr: '13', titlu: 'Lehuzia patologică', total: 10, citite: 4 }, { nr: '14', titlu: 'Anestezia în obstetrică', total: 5, citite: 0 }, { nr: '12', titlu: 'Embolia', total: 3, citite: 3 }],
      citite: [{ id: '13-4', titlu: 'Mastita', data: '2026-11-21' }],
      recap: { disponibil: false, lectii: [] },
    }),
    nextMissing: (lead, exclude = []) => { excluded.push([...exclude]); return [].concat(missing ?? []).find((m) => !exclude.includes(m.id) && !saved[m.id]) ?? null; },
    generatorPrompt: () => 'Scrie lecția ca JSON.',
    validate: (id, lesson) => (lesson.titlu ? { ok: true, errors: [], warnings: [], minutes: 7 } : { ok: false, errors: ['lipsește titlu'], warnings: [], minutes: null }),
    save: (id, lesson) => { saved[id] = lesson; return { id, warnings: [], minutes: 7 }; },
  };
}

export function fakeConversations(messages = []) {
  return { list: () => [], get: () => null, create: () => ({}), save: () => {}, remove: () => ({ ok: true }), messagesSince: (ts) => messages.filter((m) => m.ts >= ts) };
}

/** One guideline with two sections, a newer-guidance file, and the curriculum pseudo-guide. */
export function fakeLibrary() {
  const guide = { nr: '17', titlu: 'Hipertensiunea asociată sarcinii', versiune: '2019', pagini: 46, fisier: 'ghiduri-sogr/17-hta.md', url: 'https://example.org/17.pdf' };
  const files = { 'ghiduri-sogr/17-hta.md': Array.from({ length: 300 }, (_, i) => `linia ${i + 1}`) };
  return {
    files,
    guides: () => [guide],
    toc: (nr) => {
      if (nr === 'curriculum') return { nr, titlu: 'Curriculum OG (2019)', versiune: '2019', url: null, fisier: 'curriculum/_book.md', sectiuni: [{ nr: '01', titlu: 'Pregătirea de bază', pagini: '9–16', linii: [1, 378], fisier: 'curriculum/cap-01.md' }] };
      if (Number(nr) !== 17) throw httpError(404, 'negasit');
      return {
        nr: '17', titlu: guide.titlu, versiune: guide.versiune, url: guide.url, fisier: guide.fisier, total: 300, actualizari: 'ghiduri-sogr/actualizari/17-hta.md',
        sectiuni: [
          { nr: '6.1', titlu: 'Conduită în preeclampsie', pagini: '16–18', linii: [100, 180], ghiduriNoi: [12, 30] },
          { nr: '6.2', titlu: 'Eclampsia', pagini: '23–25', linii: [181, 260], ghiduriNoi: null },
        ],
      };
    },
    readLines: (fisier, from, to) => {
      const all = files[fisier];
      if (fisier.includes('..')) throw httpError(403, 'interzis');
      if (!all) throw httpError(404, 'negasit');
      const end = Math.min(to, all.length);
      return { fisier, from, to: Math.max(end, from - 1), total: all.length, text: all.slice(from - 1, end).join('\n') };
    },
    search: (q, { ghid, limit = 8 } = {}) => (fold(q).includes('magneziu') ? [{ fisier: guide.fisier, nr: '17', titlu: guide.titlu, sectiune: '6.2 Eclampsia', pagina: 25, linii: [200, 210], fragment: 'sulfat de <mark>magneziu</mark> &amp; reflex patelar' }].slice(0, limit) : []),
  };
}

export function fakeDeps(over = {}) {
  return { registru: fakeRegistru(), memorie: fakeMemorie({ profil: 'Rezidenta, rezident anul I.' }), library: fakeLibrary(), lessons: fakeLessons(), conversations: fakeConversations(), ...over };
}
