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
   With Docker (Compose v2.24+) on a host whose public IPv4 is one of its own
   addresses, it also runs SlowMeet on the host network by recording
   `COMPOSE_FILE=docker-compose.yml:deploy/compose.host-network.yml` in `.env`
   (no `docker-proxy` process per media port, no NAT on the media path). Later
   updates and plain `docker compose` commands reuse that line. Set
   `COMPOSE_FILE=docker-compose.yml` to stay on the bridge network; an existing
   `COMPOSE_FILE` is never changed by this choice. With TURN enabled it sets
   up the TURN relay built into SlowMeet (there is no separate TURN
   container), and it:
   - switches the relay on and records its settings in `.env`:
     `TURN_SERVER_ENABLED=true`, `TURN_SERVER_REALM`, a generated
     `TURN_SHARED_SECRET`, and `TURN_URLS` for UDP and TCP 3478 and TLS 5349
     on the domain.
   - adds the relay's Compose override, which publishes those ports and
     mounts the certificate copy. With Docker it inserts
     `deploy/compose.turn.yml` into `COMPOSE_FILE` right after the first file
     (before the host-network override, which then drops the published
     ports); with Podman it passes `deploy/podman-compose.turn.yml` with `-f`
     in its own commands and in the systemd unit.
   - raises the memory limits the relay shares with the app, when they are
     still the shipped values: `SLOWMEET_MEMORY_LIMIT` 256m to 384m and
     `SLOWMEET_GOMEMLIMIT` 200MiB to 300MiB. Values you changed are kept. The
     CPU limit is not changed: `SLOWMEET_CPUS` stays at 0.75 unless you raise
     it.
   - gives the relay its own certificate copy in `/etc/slowmeet/turn-certs`,
     owned by the user the SlowMeet container runs as (`10001:10001`), which
     cannot read the proxy's root-owned copy. The renewal hook refreshes both
     copies. The relay notices the new files by itself, so a renewal restarts
     nothing and relayed calls stay connected. An update rewrites an existing
     hook.

   The relay forwards only to this server's own address, so a TURN credential
   cannot be used to relay elsewhere or to reach private services.
4. **Configure UFW.** It allows the detected SSH port (or TCP 22), TCP 80, the
   WebRTC UDP range `50000:50100`, and TCP 443 when HTTPS is enabled. TURN adds
   UDP/TCP 3478 and TCP 5349. The relay port range (`49152:49999`) gets no
   rule: only SlowMeet's own SFU sends to it. It then enables
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
   starts SlowMeet (with its TURN relay when TURN is enabled), then checks the app's
   readiness and the local HTTP or HTTPS health endpoint. Only after checks
   pass does it mark state complete and print the URL and configured
   credentials.

## Update and resume

Updates are limited to a recognized installation in `/opt/slowmeet`; tracked
local changes in that checkout stop the update rather than being overwritten.
The script reads the existing environment and saved engine/proxy settings,
marks the update incomplete, fetches the latest shallow `master` checkout, and
builds the new image right away: the old containers still serve meanwhile, and
nothing in `.env`, the renewal hook, or the Podman unit has been changed yet,
so a build that fails leaves the installation running as it was. Only then
does it apply its settings, replace the containers, and wait for readiness and
a local proxy health check. With Docker, `docker compose up -d` replaces the
container because its image changed. `podman-compose up -d` starts the
existing container again unless the Compose configuration changed, so with
Podman the update first removes the containers with `down`, which keeps the
data volume, and then starts them from the new image. It preserves the
environment and credentials, application data volume, container engine, proxy
choice, certificates, and TURN configuration. Existing Nginx or Caddy
configuration is validated before activation so an update does not silently
replace unrelated proxy configuration.

With Caddy, the update reads the SlowMeet domain from the installer's managed
block in `/etc/caddy/Caddyfile` (between the `BEGIN` and `END SlowMeet
installer managed site` lines). Sites you add around that block, such as one
that only answers ACME challenges for a TURN host name, do not make the
installation ambiguous and are written back untouched. An older Caddyfile
without the block must still hold exactly one site, or the update stops.

Another service may own TCP port 443 in front of Caddy: HAProxy or another
SNI router that sends TURN over TLS to the relay and web traffic to Caddy on
another port. Say so in the Caddyfile with the `https_port` global option, as
Caddy needs anyway. The update then checks that port, not 443, for a
conflicting listener, and keeps HTTPS on. Without `https_port`, a foreign
listener on 443 still makes the update fall back to the HTTP site, as before.

### Updating an installation that ran coturn

Earlier versions ran coturn in its own container. An update moves such an
installation to the relay built into SlowMeet. Browsers keep the same TURN
addresses and credentials: `TURN_URLS` and `TURN_SHARED_SECRET` are not
changed. The new image is built first, while coturn still serves and before
any of the steps below, so a failed build leaves coturn, its configuration,
and its certificate copy as they were. The update then:

- switches the relay on and adds its Compose override, as on a fresh install;
- keeps listen ports you changed in `turnserver.conf` (as `TURN_SERVER_PORT`
  and `TURN_SERVER_TLS_PORT`) and its realm. A port below 1024 cannot be kept,
  because the SlowMeet container may not bind it; the installer prints a
  warning and the relay uses its default port, so adjust `TURN_URLS` or the
  router in front of it. coturn's relay port range is not carried over;
- raises the app container's memory limits as on a fresh install. coturn's
  CPU limit (`TURN_CPUS`) is not moved over: `SLOWMEET_CPUS` stays as it is,
  and the relay shares it. If coturn had its own CPU allowance on this host,
  relayed calls now compete with the SFU for the app's; raise `SLOWMEET_CPUS`
  if you see throttling;
- re-owns the certificate copy in `/etc/slowmeet/turn-certs` for the SlowMeet
  container user. A `TURN_CERT_DIR` of your own is left alone; make its files
  readable by user `10001` yourself;
- sets `turnserver.conf` aside as `turnserver.conf.migrated` (readable by root
  only, as it holds the shared secret); nothing reads it any more;
- removes the coturn container and starts SlowMeet from the image built at
  the start, so TURN is only down for the container swap.

Relayed calls drop while the containers restart, as on any update.

The update removes nothing coturn used, so that it can be rolled back. It
prints two reminders when it migrates:

- the UFW rule for the old relay port range stays in place. The built-in
  relay does not need it; coturn does. Once you no longer intend to roll back,
  remove it with `ufw delete allow 49152:49999/udp`;
- relayed media now shares `SLOWMEET_CPUS`, and coturn's `TURN_CPUS` no longer
  applies. `TURN_CONFIG_FILE`, `TURN_CPUS`, `TURN_MEMORY_LIMIT`, and
  `TURN_PIDS_LIMIT` stay in `.env` although nothing reads them; delete them,
  and `deploy/coturn/turnserver.conf.migrated`, at the same point.

#### Rolling back

To return to coturn if the built-in relay does not work on your host, as root
in `/opt/slowmeet`:

1. Check out the last commit that shipped coturn. The installer's checkout is
   shallow and does not hold that commit, so fetch it first:
   `git fetch --depth=1 origin 0de4740ea6c1b9a62f5c6d95cc09f09093e13968 && git checkout FETCH_HEAD`.
2. Restore the configuration:
   `mv deploy/coturn/turnserver.conf.migrated deploy/coturn/turnserver.conf`
   and `chmod 0644` it.
3. In `.env`, set `TURN_SERVER_ENABLED=false` and remove
   `:deploy/compose.turn.yml` from `COMPOSE_FILE` (delete the line if nothing
   else is left but `docker-compose.yml`).
4. Give coturn its certificate copy back:
   `chown -R 65534:65533 /etc/slowmeet/turn-certs`.
5. Make the renewal hook do the same from now on, or coturn loses TURN over
   TLS at the next renewal:
   `sed -i 's/-o 10001 -g 10001/-o 65534 -g 65533/g' /etc/letsencrypt/renewal-hooks/deploy/slowmeet`.
   The hook no longer tells coturn to re-read its certificate; after a renewal
   run `docker compose --profile turn kill -s SIGUSR2 coturn` (or restart it).
6. With Podman, point the systemd unit back at the coturn profile. It names
   the relay's override file, which this checkout does not have, so without
   this step the containers do not start at the next boot:
   `sed -i 's# -f /opt/slowmeet/deploy/podman-compose.turn.yml# --profile turn#' /etc/systemd/system/slowmeet-podman.service && systemctl daemon-reload`.
7. Start both containers: `docker compose --profile turn up -d --build`
   (Podman: `podman-compose -f podman-compose.yml --profile turn up -d --build`).

Do not run the installer's update afterwards until you want to move again: it
checks out the latest version and migrates.

Once Docker's `COMPOSE_FILE` lists the relay override, a later update no
longer switches a bridge-network installation to host networking by itself
(it only makes that choice while `COMPOSE_FILE` is empty). To switch, append
`:deploy/compose.host-network.yml` to `COMPOSE_FILE`.

The installer writes progress state atomically through a temporary file and
rename. If provisioning fails, state remains incomplete; rerunning the command
offers resume with saved choices. This is why the installer does not treat a
failed run as a clean slate or blindly reclone over the existing directory.

## Uninstall and retained data

Uninstall requires typing the installation domain. Before removing anything,
the script validates the saved domain, checkout, selected container engine, and
installer-managed proxy configuration. It stops and removes the SlowMeet
containers (and a coturn container left from an older version), removes the
Podman unit if applicable, removes its Nginx site or
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
