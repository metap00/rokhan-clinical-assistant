# Deploying Rokhan

Rokhan is built for one user and one small Linux server. The app listens on loopback only; a reverse proxy with HTTPS
puts it in front of the phone. The original deployment used Tailscale Serve, so the app is reachable only from the
owner's own devices.

## 1. The server

```sh
# Node 24 or later
git clone <this repository> ~/rokhan
cd ~/rokhan
npm ci --omit=dev
cp .env.example .env
chmod 600 .env
```

In `.env` set at least:

- `ROKHAN_PASSWORD`: the single login password.
- `ROKHAN_PUBLIC_ORIGIN`: the HTTPS address the phone uses, for example `https://rokhan.<your-tailnet>.ts.net:8444`.
  It turns on the `Secure` cookie and the `Origin` check on every state-changing request.

The assistant needs a Claude login for the Claude Agent SDK on this machine, for the user that runs the service
(see the SDK documentation). Without it the chat answers with an "auth" error; everything else works.

## 2. The service

`deploy/rokhan.service` is a systemd **user** unit that expects the app in `~/rokhan`:

```sh
mkdir -p ~/.config/systemd/user
cp deploy/rokhan.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now rokhan
loginctl enable-linger "$USER"   # keep it running after logout
journalctl --user -u rokhan -f
```

## 3. HTTPS in front

With Tailscale:

```sh
tailscale serve --bg --https=8444 http://127.0.0.1:8787
```

Any reverse proxy with TLS works the same way; keep `HOST=127.0.0.1` so the app is never exposed directly.

## 4. Data and backups

Everything lives in `data/` (or `ROKHAN_DATA_DIR`): the logbook, memory pages, conversations, uploaded photos,
lessons, the guideline library, reading and watching ticks and the cookie signing key. Files are created mode `600`. Back up that folder;
deleting `secret.key` logs every session out.

The guideline library is not part of this repository (the source guidelines are copyrighted). `npm run demo`
shows the expected layout with an invented guideline in `demo/library/`.

The video catalog ships in `content/videoteca.json`. A file at `data/library/videoteca.json` wins over it and is read
again when it changes, without a restart.
