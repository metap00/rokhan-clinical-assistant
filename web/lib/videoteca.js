// Pure helpers of the Videotecă: search, filters, labels. No DOM, tested in node.
export const ACCESS = { free: 'Gratuit', signin: 'Cont Google 18+', registration: 'Înregistrare gratuită', members: 'Membri', paid: 'Cu plată' };
export const LEVEL = { basic: 'Bază', intermediate: 'Intermediar', advanced: 'Avansat' };
export const TIER = { journal: 'revistă', society: 'societate', academic: 'academic', individual: 'canal individual' };

export const NO_FILTERS = { q: '', level: 'all', free: false, hide: false };
export const isFiltering = (f) => f.q.trim() !== '' || f.level !== 'all' || f.free || f.hide;

// Lower case without diacritics, so "cezariana" finds "Cezariană".
export const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// The videos of a list of procedures, each address once, in catalog order.
export const videosOf = (procedures) => [...new Map(procedures.flatMap((p) => p.videos).map((v) => [v.url, v])).values()];

const seconds = (d) => (d ? String(d).split(':').reduce((a, n) => a * 60 + Number(n), 0) : 0);
export function totalTime(videos) {
  const min = Math.round(videos.reduce((a, v) => a + seconds(v.duration), 0) / 60);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

// The chapters cut down to what the search and the filters let through. A procedure without any video stays
// when only the search narrows the list and its names match: the gap is information too.
export function filterSections(sections, f, seen) {
  const terms = fold(f.q).split(/\s+/).filter(Boolean);
  const onlyQuery = f.level === 'all' && !f.free && !f.hide;
  return sections.flatMap((s) => {
    const procedures = s.procedures.flatMap((p) => {
      const names = fold([p.name_ro, p.name_en, p.barem, s.title_ro].join(' '));
      const videos = p.videos.filter((v) => {
        if (f.level !== 'all' && v.level !== f.level) return false;
        if (f.free && v.access !== 'free') return false;
        if (f.hide && seen.has(v.url)) return false;
        const text = `${names} ${fold([v.title, v.source, v.covers_ro].join(' '))}`;
        return terms.every((t) => text.includes(t));
      });
      const gap = !p.videos.length && onlyQuery && terms.every((t) => names.includes(t));
      return videos.length || gap ? [{ ...p, videos }] : [];
    });
    return procedures.length ? [{ ...s, procedures }] : [];
  });
}

// A short number or range reads as a tag next to the name, a longer text as its own line.
export const shortBarem = (barem) => /^\d+(-\d+)?$/.test(barem ?? '');

// "Registru: 3 din 20", "Registru: 3 din 10-20": her count against the barem as the Registru writes it.
export function registruLine(r, named = false) {
  const head = named ? `Registru, ${r.nume}:` : 'Registru:';
  return r.barem ? `${head} ${r.efectuat} din ${r.barem}` : `${head} ${r.efectuat}`;
}
