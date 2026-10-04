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

TURN URLs, credentials, and STUN servers can be entered during installation.
The script does not install or configure a local TURN server.

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
