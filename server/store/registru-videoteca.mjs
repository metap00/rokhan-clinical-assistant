// Which catalog procedures (by name_ro, exactly) show which Registru row (by row id, see registru.mjs).
// Only clear matches. test/videoteca.test.mjs checks every id and every name, so a new catalog that renames
// a procedure fails the tests (the app itself just stops showing that link).
// Left out on purpose: recoltare-cervico-vaginala (no film on sampling) and garzi (not a procedure).
export const REGISTRU_VIDEOTECA = {
  'nastere-vaginala': ['Asistența nașterii necomplicate'],
  cezariana: ['Operația cezariană, inclusiv cezariana în urgență'],
  'cezariana-uter-cicatricial': ['Cezariana pe uter cicatricial'],
  'cezariana-urgenta': ['Operația cezariană, inclusiv cezariana în urgență'],
  ventuza: ['Ventuza obstetricală'],
  forceps: ['Aplicația de forceps'],
  'nastere-pelvina': ['Nașterea în prezentație pelviană'],
  epiziotomie: ['Epiziotomia și sutura perineului'],
  'sutura-rupturi': ['Epiziotomia și sutura perineului', 'Repararea leziunilor obstetricale ale sfincterului anal'],
  'extractie-placenta': ['Extracția manuală a placentei'],
  cerclaj: ['Cerclajul colului uterin'],
  'chiuretaj-biopsic': ['Chiuretajul biopsic și chiuretajul fracționat'],
  'dilatare-aspiratie': ['Dilatarea colului și aspirația electrică', 'Aspirația manuală endouterină'],
  contraceptie: [
    'Inserția dispozitivului intrauterin și extragerea dificilă',
    'Inserția și extragerea implantului contraceptiv',
    'Sterilizarea tubară laparoscopică și salpingectomia oportunistă', // the barem counts it
  ],
  marsupializare: ['Marsupializarea chistului de glandă Bartholin'],
};
