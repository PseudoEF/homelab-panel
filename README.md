# Homelab Control Panel

A dependency-free control panel for a Termux/Android homelab. It shows CPU, memory, disk, network, temperatures and battery, reads runit service state and logs, and can start/stop/restart a small allow-list of services. The real panel is LAN-only; a separate read-only demo serves synthetic data at [panel.pseudoef.pp.ua](https://panel.pseudoef.pp.ua/).

## Why it exists

A phone is a useful low-power server, but SSH-only administration is slow. This panel puts the few things needed for day-to-day operation on one screen without a database, a framework, a bundler, or a third-party monitoring service.

![Panel overview](docs/screenshot.png)

The design is deliberately small:

- one Node.js HTTP server using only the standard library;
- one HTML file, one stylesheet and one vanilla-JS file;
- scrypt password hashing, in-memory sessions, CSRF tokens and login lockout;
- runit for supervision, nginx for local routing, Cloudflare Tunnel for the public demo only.

## Security model

- The real panel binds to the LAN and is **not** exposed through the tunnel. Do not publish port `8081`.
- The public demo is a separate process on `127.0.0.1:8082`, with a GET-only synthetic API and no access to the real filesystem or runit.
- `auth.json` contains only a salted scrypt hash. It is created with mode `0600` and is gitignored.
- Sessions live in memory and expire after 12 hours. The password is rate-limited and locks out after five failures for five minutes.
- Service control is limited to `CONTROLLED_SERVICES`; project records are validated, and paths are constrained.
- This is a homelab tool, not a multi-tenant control plane. Put it behind a trusted LAN/VPN, keep the host patched, and do not run it as root.

## Requirements

- Node.js 20.11+ (CI uses Node 24)
- Termux on Android for the real deployment
- runit/termux-services for the services shown in the panel
- nginx if you want the local routing used here

No npm dependencies are needed for the panel itself.

## Run locally

```bash
git clone https://github.com/pseudoef/homelab-panel.git
cd homelab-panel
mkdir -p runtime
PANEL_DIR="$PWD/runtime" PANEL_HOST=127.0.0.1 PANEL_PORT=8081 node server.js
```

Set a password before the first login:

```bash
PANEL_DIR="$PWD/runtime" node server.js --set-password
# type a password of at least 8 characters
```

Then open <http://127.0.0.1:8081/> and log in. On a non-Termux machine, service and metric commands may return empty values; the UI still loads. For the real metrics, run it on Termux.

### Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `PANEL_DIR` | `$HOME/panel` | Directory containing `public/`, `auth.json`, `projects/` |
| `PANEL_HOST` | `0.0.0.0` | Bind address; use `127.0.0.1` behind a local proxy |
| `PANEL_PORT` | `8081` | HTTP port |
| `TERMUX_PREFIX` | `/data/data/com.termux/files/usr` | Termux prefix used for commands |
| `HOME` | OS home | Base for logs and the default panel directory |

`PANEL_HOST=0.0.0.0` is intentional for LAN access. Do not put this port on a public interface.

## Termux deployment

```bash
# On the phone
mkdir -p "$HOME/panel"
cd "$HOME/panel"
# copy server.js and public/ here, then:
node server.js --set-password
```

A minimal runit service:

```sh
#!/data/data/com.termux/files/usr/bin/sh
cd /data/data/com.termux/files/home/panel
exec /data/data/com.termux/files/usr/bin/node server.js \
  >> /data/data/com.termux/files/home/logs/panel.txt 2>&1
```

Place it at `$PREFIX/var/service/panel/run`, make it executable, and start it with `sv up panel`. The real panel used in this project listens on `8081`; nginx keeps that port on the LAN.

## Public demo

The public demo is a separate codebase/process. It reuses the visual layer but replaces every system call with fixtures, forces an authenticated read-only session, disables write endpoints, and serves only an explicit allow-list of files. See the live demo: <https://panel.pseudoef.pp.ua/>.

Do not expose the real panel to achieve the demo. The separation is the security boundary.

## Tests

```bash
npm test
```

The test creates a temporary panel directory and password, starts the server on loopback, and checks the login screen, unauthenticated API boundary, wrong-password rejection, successful login, session cookie and authenticated `/api/session`.

## Layout

```text
server.js              HTTP server, auth, metrics, runit/project API
public/index.html      app shell and modal markup
public/app.js          polling UI, charts, service/log views, project forms
public/style.css       visual system
test/panel.test.mjs    auth smoke test
```

## License

No license has been granted yet. The source is public for review and portfolio purposes; do not redistribute it without permission.
