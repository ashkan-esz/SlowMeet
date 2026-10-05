# Test SlowMeet over HTTPS on your LAN

Camera and microphone access requires a secure browser origin. Opening
`http://<computer-LAN-IP>:8080` from a phone may load the page, but browsers
block those device permissions on an insecure origin. For local testing, run
SlowMeet with `go run .` and put Caddy in front as a LAN-only HTTPS proxy.

1. Copy `deploy/caddy/lan.Caddyfile.example` to a temporary file and replace
   `192.168.1.20` with the computer's LAN IPv4 address.
2. Start Caddy with `caddy run --config /path/to/lan.Caddyfile --adapter caddyfile`.
   The example listens on port `8443` and proxies to SlowMeet on `8080`.
3. Find Caddy's local root certificate at
   `pki/authorities/local/root.crt` under Caddy's data directory. Transfer the
   public certificate to the phone and install it as a trusted CA in the
   phone's certificate settings.
4. Open `https://<computer-LAN-IP>:8443/` on the phone. Both devices must be on
   a network that allows them to reach each other.

For a manually run Caddy process, the default data directory is
`~/.local/share/caddy` on Linux, `~/Library/Application Support/Caddy` on
macOS, or `%AppData%\Caddy` on Windows. If `XDG_DATA_HOME` is set, use
`$XDG_DATA_HOME/caddy` instead.

Install and trust the local root certificate; do not bypass the browser's
certificate warning. Keep Caddy's CA private key on the computer, and remove
the CA from the phone when the test is complete. For regular use, prefer a
hostname with a publicly trusted certificate.

For production, put Caddy, Nginx, or another TLS reverse proxy in front of
SlowMeet. Examples are in `deploy/caddy/Caddyfile` and
`deploy/nginx/slowmeet.conf`. Preserve WebSocket upgrade headers and allow
long-lived connections. Configure DNS and certificates for the actual
hostname. The `deploy/systemd/slowmeet.service` file is a least-privilege
service template for non-container installs.

For low-bandwidth testing with Linux `tc netem`, see
[`network-testing.md`](network-testing.md). The `scripts/netem.sh` runner
applies named network scenarios and removes the queueing discipline when it
exits.
