# `deploy/install-container.sh`: behavior and rationale

This guide describes the smaller image-based VPS installer. Its source of
truth is [`deploy/install-container.sh`](../deploy/install-container.sh). It
installs SlowMeet from a published GHCR image and never downloads the project
source or builds an image on the VPS. The original
[`deploy/install.sh`](../deploy/install.sh) and its guide remain separate.

Run the script as root on Ubuntu or Debian with an interactive terminal. It
installs the selected Docker or Podman package from the OS package repository
only when that runtime is missing. It does not configure the host firewall, a
web proxy, or TLS. The operator must allow the chosen HTTP port and UDP ports
`50000-50100` in any host or cloud firewall that applies.

## Startup checks and choosing an operation

The script checks that it is running as root, has a terminal, and is on Ubuntu
or Debian. It stores its files under `/opt/slowmeet-container` and its state
under `/var/lib/slowmeet-container-installer`, separate from the original
installer's paths.

On a new installation, prompts select Docker or Podman, loopback or public
HTTP binding, a published image tag, the host HTTP port, and app credentials
and ICE settings. `latest` is the default image tag; Docker uses
`ghcr.io/ashkan-esz/slowmeet:latest`, while Podman uses the published
`ghcr.io/ashkan-esz/slowmeet:latest-podman`. A release tag such as `1.2.3` is
also accepted. The app environment file is mode `0600` and contains the admin
password.

If a prior run left incomplete state, rerunning the script offers to resume,
uninstall, or cancel. A completed installation offers update, uninstall, or
cancel. Updates pull the chosen image tag and recreate the named container
while keeping its data volume and environment file.

## Fresh installation

The script installs and enables the selected runtime if needed, writes the app
environment, creates a named data volume, pulls the published image, and
starts the container with a restart policy. The container runs with a
read-only filesystem, a temporary `/tmp`, dropped capabilities, and
`no-new-privileges` enabled. The image's health check must pass before the
installer marks the operation complete. Docker uses its `unless-stopped`
restart policy; Podman uses `always` with `podman-restart.service` enabled so
the container starts after reboot.

The HTTP port binds to `127.0.0.1` for an existing local reverse proxy or to
`0.0.0.0` for direct access. The script leaves proxy and firewall settings
untouched and prints the network ports the operator may need to allow. Public
browser use requires the operator to provide an appropriate secure web entry
point separately.

STUN servers can be entered during installation. For participants whose
networks block direct media, the installation asks which TURN relay to use:

- `none` (the default): no relay.
- `builtin`: the relay built into SlowMeet. The script asks for the public
  host name or IPv4 address browsers reach this server by (it must resolve
  straight to this host, not to a CDN or an HTTP-only proxy), generates
  `TURN_SHARED_SECRET`, and writes `TURN_SERVER_ENABLED=true` and `TURN_URLS`.
  For TURN over TLS it also asks for a directory that holds `fullchain.pem`
  and `privkey.pem` for that host name, readable by user `10001`; the
  directory is mounted read-only and renewed files are picked up without a
  restart.
- `external`: a TURN server you run elsewhere. The script asks for its URLs
  and for the secret it shares with SlowMeet (coturn: `use-auth-secret` with
  `static-auth-secret`).

Browsers only ever receive time-limited credentials derived from the shared
secret. A fixed TURN username and password would never reach them, so the
script does not ask for one; `TURN_USERNAME` and `TURN_PASSWORD` in an
existing `.env` are left as they are and, as before, serve only the server's
own connections.

When `.env` has `TURN_SERVER_ENABLED=true`, the container is started with the
relay's listen ports published: `TURN_SERVER_PORT` (3478) over UDP and TCP,
and, with `TURN_CERT_DIR` set, `TURN_SERVER_TLS_PORT` (5349) over TCP. This
also applies to an existing installation whose `.env` you edit by hand: the
next update publishes them. A port another service on the host already holds
is left out with a warning rather than failing the update. Allow the
published ports in the host and cloud firewalls. The
[configuration guide](configuration.md#built-in-turn-relay) describes the
relay's settings.

## Update and resume

An update pulls the selected Docker or Podman image tag, removes the existing
SlowMeet container, then starts a replacement using the existing environment
and data volume. If an operation fails before completion, the state remains
incomplete and a later run offers to resume it. The container may be briefly
unavailable during replacement.

The installer does not change the running proxy, TLS, or firewall setup. To
change the HTTP binding or other saved app settings, edit
`/opt/slowmeet-container/.env` and recreate the container through the selected
runtime.

## Uninstall and retained data

Uninstall requires typing `uninstall`. It removes the named container and the
installer's environment and state files. The persistent data volume is kept
unless the operator separately confirms permanent deletion. Installed Docker
or Podman packages and their system services are left in place.

## Managed files

| Path or resource | Purpose |
| --- | --- |
| `/opt/slowmeet-container/.env` | App settings and credentials |
| `/var/lib/slowmeet-container-installer/state` | Runtime, image, and resumable operation state |
| `slowmeet-container` | Container name |
| `slowmeet-container-data` | Persistent app data volume |

The installer refuses to use an existing install directory when it has no
matching state file, and it does not reuse or remove the original installer's
container, environment, or data volume.
