# Videotecă, reading checklist, film of the day

Three additions that share one idea: the app remembers what has been watched and read, and picks the next thing.

## Videotecă

A tab with a catalog of public operation videos: 302 films for 119 procedures in 13 chapters, a "Start aici" list of 15,
and 23 video libraries with their access conditions. The links were checked on 2026-11-27. Nothing is embedded: a film
opens on its publisher's site.

- Search without diacritics; filters by level, "no account needed" and "hide watched".
- "Văzut" on every film, stored on the server and keyed by the film's address, so a tick survives a new catalog.
- Progress overall and per chapter. Another device shows new ticks when the app comes back to the front.
- Procedures that have a logbook row show its count ("Registru: 4 din 50"). Logbook rows with films open them in place.

## Reading checklist

In Ghiduri a whole guideline or a single section can be ticked, with a count of guidelines read. "Continuă de unde ai
rămas" reopens the last guideline, section and scroll position. Ticks follow a section by its number and title, so a
re-imported library keeps them. The guideline files are only read.

## Film of the day

The next unwatched film: "Start aici" in its order, then the catalog order. It is shown at the top of the Videotecă and
added to the daily notification. There is no second schedule.

| Day | Title | Body | Tap opens |
|---|---|---|---|
| Lesson day | `Lectura de azi` | the lesson, then `Filmul zilei: <title> (<length>)` on a second line | the lesson |
| No lesson to announce | `Filmul zilei` | `<title> (<length>)` | that film |

- "No lesson to announce" means one was already read today and no review is due, or the lesson plan is finished.
- The Sunday recap and the review reminder behave like a lesson day.
- With the daily notification off, nothing is sent. With the film switch off (Mai mult, Notificări), the notification
  carries the lesson only and the top of the Videotecă shows no film.
- While today's lesson is still being written, the job waits for it.
- A catalog or tick file that cannot be read is logged and never stops the lesson notification.

## Files

| What | Where |
|---|---|
| Catalog shipped with the code | `content/videoteca.json` |
| Catalog override, wins when present, no restart | `<data>/library/videoteca.json` |
| Film ticks | `<data>/videoteca-vazute.json` |
| Guideline ticks and last position | `<data>/ghiduri-citite.json` |
| Logbook row to catalog procedure | `server/store/registru-videoteca.mjs` |

A new catalog is a file replacement. Only `http` and `https` addresses reach a link. `npm test` checks the shipped
catalog and fails when a mapped procedure was renamed or two procedures share a name. Fifteen of the 17 logbook rows
are mapped; cervico-vaginal sampling has no film and on-call shifts are not a procedure.

## Not checked

Opening a film from the installed app on a real iPhone, and delivery of a real push notification. The demo runs no
background jobs, so it shows the film at the top of the tab and the switch, not a notification.
