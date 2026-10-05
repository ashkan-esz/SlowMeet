# SlowMeet

SlowMeet is a small, self-hosted single-meeting video call focused on usable
audio and graceful degradation on slow or unstable connections.

The current MVP provides:

- One meeting at `/`
- Browser-persisted meeting preferences and device selections
- Optional meeting password
- Up to five participants by default
- WebSocket signaling and Pion WebRTC
- SFU RTP forwarding without server-side transcoding
- Camera/microphone controls
- Per-user remote video pause/resume control
- Bandwidth profiles and automatic video degradation
- Server-side RTP bitrate/FPS ceilings that drop excess packets without buffering
- Single active screen-share lease with disconnect cleanup
- Connection recovery, diagnostics, and runtime admin limits

## How SlowMeet handles weak connections

SlowMeet uses an SFU: each participant sends one copy of their published media
to the server, which forwards it to the other participants. This can reduce
upload demand compared with mesh calls, where participants send separate copies
to each peer. It does not remove the need for a reliable path to the server or
enough download capacity for the media a participant receives.

Automatic quality uses network measurements to lower video quality when a
connection struggles. If conditions become critical, SlowMeet can pause video
to help audio remain usable. These steps manage the available bandwidth; they
cannot create more of it or guarantee call quality.

When a network blocks direct UDP, a configured TURN relay can provide another
connection path. TURN must be configured by the operator, and relaying can add
latency. Simulcast layer switching is also available, but is disabled by default.

These features are not an Iran-specific optimization. Results depend on each
participant's access network and routing, as well as the location and quality
of the SFU and TURN server. Validate performance on Iranian mobile and fixed
connections before making regional performance claims.

## Run locally

```sh
cp .env.example .env
go run .
```

Open `http://localhost:8080/`.

Run tests and build:

```sh
go test ./...
go build ./...
node scripts/test-admin.js
```

Run the local HTTP smoke test:

```sh
./scripts/smoke.sh
```

## Configuration

The complete starter configuration is in `.env.example`.

## One-command VPS deployment

On a fresh Ubuntu or Debian VPS, point an A record for your domain to the VPS
IPv4 address. If the domain has an AAAA record, point it to the VPS IPv6 address
or remove it. Then run this command as a user with `sudo` access. Run the same
command on a standard existing SlowMeet installation to update it in place:

```sh
sudo bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/ashkan-esz/SlowMeet/master/deploy/install.sh | bash'
```

This command downloads and immediately runs the current installer from the
`master` branch with root privileges. It is not pinned to a release; review the
repository and installer source before running it.

For the installer's full execution flow, system changes, safety checks, and
update/uninstall behavior, see [the install script guide](docs/install-script.md).

For a fresh installation, the installer asks for the domain, optional TURN and
meeting-password settings, the container engine (`docker` by default or
`podman`), the local app port (default `8080`), and an admin password. Admin
password entry is hidden; leave it blank to generate one. Podman installs use
`podman-compose` and a SlowMeet-specific systemd unit to start containers after
reboot. If Nginx is already running, the installer adds a dedicated virtual
host and uses Certbot for HTTPS without replacing other Nginx sites. Otherwise,
it configures Caddy. It builds and starts SlowMeet, waits for health checks,
and prints the chosen credentials when setup completes.

If Xray owns TCP port 443, the installer can keep it there when it finds one
VLESS or Trojan TCP+TLS inbound in a single JSON config. It adds a hostname
fallback to Caddy on `127.0.0.1:9080`, validates and restarts Xray, and uses
Xray's existing TLS certificate and renewal process. The restart briefly
disconnects active Xray clients. REALITY, multi-file Xray configs, and other
inbound types are left unchanged and prevent HTTPS setup; the installer reports
that condition and continues with HTTP if the proxy can start safely.

If TCP port 443 remains unavailable, installation can still complete with the
app served over HTTP when the selected proxy can safely start on port 80. The
installer prints the reason at completion and retries HTTPS setup on a later
resume or update. Browsers may restrict meeting media features until HTTPS is
available.

When it detects an existing installation, the installer offers update (the
default) or uninstall. Update fetches the latest source, rebuilds and restarts
SlowMeet, and preserves its environment, credentials, application data,
container engine, proxy choice, certificates, and TURN configuration. Existing
installations must use the standard `/opt/slowmeet` checkout and
installer-managed proxy configuration.

Uninstall requires typing the installation domain. It removes the SlowMeet
containers, application files, and installer-managed proxy integration while
leaving shared container/proxy packages, firewall rules, and Let's Encrypt
certificates in place. The persistent application data volume is preserved
unless you separately confirm its permanent deletion. An interrupted install
offers resume (the default) or uninstall.

If installation or update fails after provisioning starts, fix the reported
issue and run the same command again. The installer resumes with the saved
domain and options, preserving any configuration and credentials it already
created.

The domain must already resolve to the VPS before installation so HTTPS
certificates can be issued. The installer opens the VPS host firewall for SSH,
HTTP, HTTPS, and the UDP ports used for WebRTC. If you enable TURN, it also
opens TCP/UDP 3478, TLS/TCP 5349, and the configured TURN relay range. If your
provider has a separate cloud firewall, it must already allow those same
ports; the installer cannot change provider dashboard rules. Keep the
generated admin password somewhere safe.

### Simpler published-image installer

For a smaller setup that runs a published image without downloading or
building the project on the VPS, use the alternative installer:

```sh
sudo bash -c 'export DEBIAN_FRONTEND=noninteractive; apt-get update && apt-get install -y ca-certificates curl && curl -fsSL https://raw.githubusercontent.com/ashkan-esz/SlowMeet/master/deploy/install-container.sh | bash'
```

It supports Docker and Podman, installs the selected container runtime if it is
missing, and offers install, resume, update, and uninstall actions. It prompts
for the image tag (default `latest`) and HTTP binding. It leaves firewall,
proxy, and TLS setup to the operator. See the [published-image installer
guide](docs/install-container-script.md) for its behavior and requirements.

Set `MEETING_PASSWORD` to require a password at join time. Set
`ADMIN_PASSWORD` separately to enable `/admin` and protect runtime settings.
Passwords are never sent to the frontend or written to logs.
Each WebSocket connection is limited to five join attempts to bound password
guessing and repeated join retries; reconnecting clients can open a fresh
connection when needed.

Open `/admin` to use the protected operations cockpit. It shows readiness,
active participants, peer connections, reconnects, RTT, packet loss, jitter,
and current audio/video bitrate, then groups the runtime limits by capacity,
video policy, audio policy, and meeting features. The dashboard refreshes
health and metrics automatically; settings remain unchanged if a save fails.

`STUN_SERVERS` accepts a comma-separated list. For users behind restrictive
NATs or networks that block UDP, configure coturn and set `TURN_URLS` to
include UDP, TCP, and TLS/TCP transports. A typical production list is:

```text
turn:turn.example.com:3478?transport=udp
turn:turn.example.com:3478?transport=tcp
turns:turn.example.com:5349?transport=tcp
```

Set `TURN_SHARED_SECRET` to enable short-lived browser and server credentials;
`TURN_CREDENTIAL_TTL_SECONDS` defaults to 24 hours. The shared secret must
match coturn's `static-auth-secret` when `use-auth-secret` is enabled.
`TURN_URL`, `TURN_USERNAME`, and `TURN_PASSWORD` remain supported for
server-side legacy configurations, but static credentials are not sent to
browsers.

`ICE_IPV4_ONLY=true` is the default because it avoids broken or slow IPv6
paths. Set it to `false` only after IPv6 has been tested from your target
networks. `ICE_PUBLIC_IP` optionally rewrites host ICE candidates for servers
behind 1:1 NAT; the VPS installer detects and sets the public IPv4 address.

`MAX_VIDEO_QUALITY`, `MAX_VIDEO_BITRATE`, `MAX_VIDEO_FPS`, and
`MAX_AUDIO_BITRATE` are enforced as hard ceilings. The quality ceiling limits
the browser profile resolution; bitrate and FPS ceilings are also enforced by
the SFU, which drops excess RTP immediately rather than queuing or
transcoding. The built-in profiles include `very-good` at 720p/60 FPS and
`ultra` at 1080p/30 FPS; the starter configuration permits both with a 3 Mbps
video ceiling, a 60 FPS ceiling, and a 96 kbps audio ceiling.

## Docker and Podman

### Deploy a published image

Create a directory on the server with a `compose.yaml`:

```yaml
services:
  slowmeet:
    image: ${SLOWMEET_IMAGE}
    restart: unless-stopped
    env_file: .env
    ports:
      - "${HTTP_PUBLISH_ADDRESS:-127.0.0.1}:${HTTP_PUBLISH_PORT:-8080}:8080"
      - "${ICE_UDP_PORT_MIN:-50000}-${ICE_UDP_PORT_MAX:-50100}:${ICE_UDP_PORT_MIN:-50000}-${ICE_UDP_PORT_MAX:-50100}/udp"
    volumes:
      - slowmeet-data:/app/data
volumes:
  slowmeet-data:
```

Create `.env` beside it. Use a released version tag and set a strong admin
password:

```dotenv
SLOWMEET_IMAGE=ghcr.io/ashkan-esz/slowmeet:1.2.3
APP_ENV=production
HTTP_ADDR=:8080
CONFIG_FILE=data/config.json
ADMIN_PASSWORD=replace-with-a-long-random-secret
HTTP_PUBLISH_ADDRESS=127.0.0.1
HTTP_PUBLISH_PORT=8080
ICE_UDP_PORT_MIN=50000
ICE_UDP_PORT_MAX=50100
ICE_PUBLIC_IP=
STUN_SERVERS=
TURN_URLS=
TURN_USERNAME=
TURN_PASSWORD=
```

Keep `.env` private. For Docker, use the image tag shown. For Podman, append
`-podman` to the version (for example, `1.2.3-podman`); on SELinux hosts, add
`:Z` to the data volume mount. Start and check the service with either engine:

```sh
docker compose up -d
docker compose ps
docker compose logs -f slowmeet
# Or use `podman compose` for each command.
```

Health checks are at `/health` and `/ready`. To update, change the image tag in
`.env`, then run `docker compose pull && docker compose up -d` (or the Podman
equivalent). `docker compose down` stops the service and keeps its data; avoid
`down --volumes` unless you intend to delete it.

Allow the configured ICE UDP range through the host and cloud firewalls. Put a
TLS reverse proxy in front of SlowMeet for public use; this example binds HTTP
to loopback for a proxy on the same host. For direct HTTP access, set
`HTTP_PUBLISH_ADDRESS=0.0.0.0`. TURN configuration and detailed network notes
are below.

### Build from source

Docker Compose:

```sh
cp .env.example .env
docker compose up -d --build
```

With the optional coturn profile:

```sh
docker compose --profile turn up -d --build
```

Podman through its Compose wrapper:

```sh
podman compose -f podman-compose.yml up -d --build
```

Podman Compose requires an external Compose provider to be installed and
configured. Verify it before starting the stack:

```sh
podman compose version
make podman-check
```

The Compose provider must be able to reach the Podman API socket. For a
rootless Podman installation using the default socket, start the user socket
before running the Make target:

```sh
systemctl --user enable --now podman.socket
```

Do not mix modes: use `make podman-build` with the rootless socket, or use
`sudo make podman-build` only after enabling the rootful socket with
`sudo systemctl enable --now podman.socket`.

The equivalent Make targets are `make docker-up`, `make docker-turn-up`,
`make podman-up`, and `make podman-turn-up`. The Make targets intentionally use
`podman compose` and do not auto-select the standalone `podman-compose`
executable.

The default CPU limits are 0.75 for SlowMeet and 0.20 for coturn, for a combined
total of 0.95 CPU when the optional TURN profile is enabled. The memory limits
remain 256 MiB and 128 MiB respectively (384 MiB combined). These are defaults;
custom `.env` values can raise them. Existing `.env` files keep their current
values when updated.

The application listens on port `8080`. Health endpoints are `/health` and
`/ready`.

Frontend assets are embedded in the Go binary, so the container and systemd
service do not need a separate runtime `web/` directory.

The Compose example publishes the configured `ICE_UDP_PORT_MIN` through
`ICE_UDP_PORT_MAX` range (default `50000-50100`) for direct ICE media
connectivity. Allow that range through the VPS firewall. TURN remains
recommended for restrictive NATs and networks that block inbound UDP.

TURN is optional and can run as the Compose `turn` profile. Open its client
listeners on UDP/TCP 3478 and TLS/TCP 5349, plus the coturn UDP relay range
configured by `min-port` and `max-port`. If you need TURN over TCP 443 while
HTTPS already uses that port on the same address, use a separate TURN IP or TCP
passthrough routing.

The optional `turn` profile expects a local copy of
`deploy/coturn/turnserver.conf.example` at `deploy/coturn/turnserver.conf` and
certificates under `deploy/coturn/certs`. These paths are ignored by Git. The
profile uses host networking so coturn can expose its full relay range without
mapping thousands of ports. Rootless Podman may need a host-level permission
change or a non-privileged TLS port for TCP 443.

The same `SLOWMEET_*` and `TURN_*` variables in `.env` can override these
defaults when hosting larger meetings.

Stable GHCR releases publish version, major.minor, major, and `latest` tags;
Podman images use the same tags with `-podman`. Prereleases publish only their
exact version tag. Images are published when a SemVer release tag is pushed.

Disconnected participants retain their meeting slot for
`RECONNECT_TIMEOUT_SECONDS` (default: 30 seconds), allowing the same browser
session to reconnect without changing participant identity.

## HTTPS and WebSockets

Production browsers require a secure origin for camera and microphone access.
Put Caddy, Nginx, or another TLS reverse proxy in front of SlowMeet. Examples
are provided in `deploy/caddy/Caddyfile` and `deploy/nginx/slowmeet.conf`.
For a non-container installation, `deploy/systemd/slowmeet.service` provides a
least-privilege service template.

The proxy must preserve WebSocket upgrade headers and allow long-lived
connections. Configure DNS and certificates for your actual hostname before
using the examples.

### Testing from a phone on your LAN

Opening `http://<computer-LAN-IP>:8080` on a phone loads the app, but browsers
block camera and microphone access on that insecure origin. Use HTTPS with a
certificate trusted by the phone. For a local test, run SlowMeet with `go run .`
and use Caddy as a LAN-only HTTPS reverse proxy:

1. Copy `deploy/caddy/lan.Caddyfile.example` to a temporary file and replace
   `192.168.1.20` with the computer's LAN IPv4 address.
2. Start Caddy with `caddy run --config /path/to/lan.Caddyfile --adapter caddyfile`.
   The example listens on port `8443` and proxies to SlowMeet on `8080`.
3. Find Caddy's local root certificate at
   `pki/authorities/local/root.crt` under its data directory. Transfer that
   public certificate to the phone and install it as a trusted CA in the
   phone's certificate settings. For a manually run Caddy process, the default
   data directory is `~/.local/share/caddy` on Linux, `~/Library/Application
   Support/Caddy` on macOS, or `%AppData%\Caddy` on Windows. If
   `XDG_DATA_HOME` is set, use `$XDG_DATA_HOME/caddy` instead.
4. On the phone, open `https://<computer-LAN-IP>:8443/`. The phone and computer
   must be on a network that allows devices to reach each other.

Do not bypass the browser's certificate warning; install and trust Caddy's root
certificate. Keep Caddy's CA private key on the computer. Remove the CA from
the phone when you no longer need this local setup. For regular use, prefer a
hostname with a publicly trusted certificate.

For low-bandwidth validation scenarios using Linux `tc netem`, see
`docs/network-testing.md`.
The included `scripts/netem.sh` runner applies named scenarios and removes the
qdisc automatically when it exits.

`/metrics` exposes Prometheus-compatible counters and latest network samples,
including active participants, peer connections, reconnects, ICE failures, RTT,
packet loss, jitter, and reported audio/video bitrate.

## Scope

SlowMeet intentionally does not include accounts, rooms, recording, chat,
transcoding, clustering, or a database in this MVP.
