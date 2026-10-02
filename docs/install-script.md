# `deploy/install.sh`: behavior and rationale

This guide describes what the VPS installer changes, the order it makes those
changes, and the checks it uses to avoid damaging an existing installation or
shared server configuration. The source of truth is
[`deploy/install.sh`](../deploy/install.sh); details can change when that script
changes.

The script provisions a SlowMeet checkout at `/opt/slowmeet` on Ubuntu or
Debian. It runs with root privileges and requires an interactive terminal,
because it changes system packages and services and asks for installation
choices and confirmations. The README's one-line command downloads the current
script from the `master` branch and immediately runs it as root; inspect the
script before using that command.

## Startup checks and choosing an operation

Before provisioning, the script checks that `/etc/os-release` identifies Ubuntu
or Debian, `apt-get` is available, it is running as root, and it can open
`/dev/tty`. The terminal is needed even when the script is piped into Bash.
It uses strict Bash error handling and reports an unexpected failing command
with its approximate source line.

The installer uses `/var/lib/slowmeet-installer/state` to distinguish an
incomplete install, a completed install, and an interrupted update. It validates
that state before using it, then checks that `/opt/slowmeet` is a recognized
SlowMeet checkout and that its `.env` matches the expected installation when
those files exist. A state file without its expected environment, or an
unrecognized checkout, causes the script to stop instead of taking ownership
of unrelated files. Older installations can be recognized from their checkout
and existing configuration.

For a new install, prompts collect the domain, whether HTTPS is required,
whether to enable TURN and meeting passwords, the container engine (Docker by
default or Podman), and the local application port. The admin password is
entered later; a blank value causes one to be generated. The domain is
normalized and validated. The script checks that its IPv4 DNS address matches
the VPS public IPv4 address; if an AAAA record exists, it must match the VPS
public IPv6 address too. This catches DNS mistakes before certificate issuance.

If an installation already exists, the default action is to update it. An
incomplete fresh install defaults to resume. Either flow also offers
uninstallation. A saved incomplete state lets a later run reuse the chosen
domain and options instead of creating a second, conflicting setup.

## Fresh installation

The installer proceeds through these steps:

1. **Install prerequisites.** It updates APT metadata and installs CA
   certificates, `curl`, Git, GnuPG, `iproute2`, OpenSSL, Certbot, and UFW.
   These provide secure downloads, repository access, network inspection,
   certificate management, and host firewall management.
2. **Install the selected runtime.** Docker mode configures Docker's signed APT
   repository and installs Docker Engine, Buildx, and the Compose plugin.
   Podman mode installs Podman and `podman-compose`. The selected engine is
   enabled or prepared for startup. Caddy mode also configures Caddy's APT
   repository and installs Caddy. If an APT failure is isolated to the Caddy
   repository, the script can use its verified Caddy binary fallback; unrelated
   APT failures stop installation. The fallback verifies the release artifacts
   before installing the executable and a restricted systemd service.
3. **Prepare SlowMeet's checkout and configuration.** It clones the shallow
   `master` branch into `/opt/slowmeet`, or updates that checkout if it is
   already present and recognized. It writes the selected settings to
   `/opt/slowmeet/.env` with mode `0600`, creates or preserves credentials,
   records the container engine and proxy choice, and saves progress under
   `/var/lib/slowmeet-installer`. These state files allow safe resumption and
   make later updates use the same engine and proxy.
4. **Configure UFW.** It allows the detected SSH port (or TCP 22), TCP 80, the
   WebRTC UDP range `50000:50100`, and TCP 443 when HTTPS is enabled. TURN adds
   UDP/TCP 3478, TCP 5349, and UDP relay ports `49152:49251`. It then enables
   UFW. These are host firewall rules; the script cannot change a cloud
   provider's separate firewall.
5. **Set up the web proxy and HTTPS.** If Nginx is already active, the script
   adds its own site file under `/etc/nginx/conf.d/` and uses Certbot for the
   domain certificate. Otherwise it uses Caddy. Caddy obtains certificates
   itself and keeps SlowMeet's configuration in a marked managed block in
   `/etc/caddy/Caddyfile`. Both paths route web traffic to the app's local port
   and support the ACME HTTP challenge. The script checks Nginx's active
   configuration and existing domain sites before editing; for Caddy, it
   validates the merged configuration and preserves unrelated content.
6. **Handle port 443 conflicts.** If Xray owns port 443 and has one supported
   VLESS or Trojan TCP+TLS inbound in a single JSON config, the installer can
   add a hostname fallback to Caddy on `127.0.0.1:9080`, validate the Xray
   config, and restart Xray. The restart can briefly disconnect Xray clients.
   Unsupported Xray configurations are left unchanged. If HTTPS is optional,
   or a safe HTTPS listener cannot be established, the installer can continue
   with HTTP when the proxy can bind port 80; it reports that HTTPS is
   unavailable. Browsers may restrict meeting media features over HTTP.
7. **Start and verify the application.** It writes a Podman systemd unit when
   Podman is selected so the Compose stack starts after reboot, builds and
   starts SlowMeet (and coturn when TURN is enabled), then checks the app's
   readiness and the local HTTP or HTTPS health endpoint. Only after checks
   pass does it mark state complete and print the URL and configured
   credentials.

## Update and resume

Updates are limited to a recognized installation in `/opt/slowmeet`; tracked
local changes in that checkout stop the update rather than being overwritten.
The script reads the existing environment and saved engine/proxy settings,
marks the update incomplete, fetches the latest shallow `master` checkout,
rebuilds and restarts the app, and waits for readiness and a local proxy health
check. It preserves the environment and credentials, application data volume,
container engine, proxy choice, certificates, and TURN configuration. Existing
Nginx or Caddy configuration is validated before activation so an update does
not silently replace unrelated proxy configuration.

The installer writes progress state atomically through a temporary file and
rename. If provisioning fails, state remains incomplete; rerunning the command
offers resume with saved choices. This is why the installer does not treat a
failed run as a clean slate or blindly reclone over the existing directory.

## Uninstall and retained data

Uninstall requires typing the installation domain. Before removing anything,
the script validates the saved domain, checkout, selected container engine, and
installer-managed proxy configuration. It stops and removes the SlowMeet
containers, removes the Podman unit if applicable, removes its Nginx site or
only its recognized Caddy managed block, and deletes SlowMeet's local
certificate copies, renewal hook, state, environment, and `/opt/slowmeet`
checkout. It leaves shared container and proxy packages, UFW rules, and
Let's Encrypt certificates in place because those may be shared with other
services.

The persistent application data volume is kept by default. The operator must
separately confirm permanent deletion before Compose is asked to remove
volumes. This protects meeting/application data from being erased as an
incidental part of removing the service.

## Managed files and safety behavior

The main installer-owned paths are:

| Path | Purpose |
| --- | --- |
| `/opt/slowmeet` | Application checkout, Compose files, and `.env` |
| `/var/lib/slowmeet-installer/state` | Operation, selected options, and resumable progress |
| `/etc/slowmeet/` | Saved proxy and container-engine choices and local certificate copies |
| `/etc/nginx/conf.d/slowmeet-installer.conf` | Dedicated Nginx site, when Nginx is selected |
| `/etc/caddy/Caddyfile` | Caddy site; the installer edits only its recognized managed block |
| `/etc/systemd/system/slowmeet-podman.service` | Podman Compose startup at boot |
| `/etc/letsencrypt/renewal-hooks/deploy/slowmeet` | Hook that refreshes SlowMeet's local certificate copies |

The script deliberately refuses to replace unknown checkouts, malformed or
modified installer-managed proxy blocks, Nginx sites that do not carry its
management marker, and conflicting domains already configured in Nginx. It
validates proxy configuration before activation and uses temporary files and
backups for Caddy changes so it can restore the prior configuration if reload
fails. Those checks make the installer safer to rerun and allow it to share a
server with other sites.
