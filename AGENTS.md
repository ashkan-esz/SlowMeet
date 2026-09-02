# Repository Guidelines

## Project Structure & Module Organization

LowMeet is a small Go WebRTC/SFU application. The entry point is `main.go`;
server packages live in `internal/`:

- `config/` handles environment-backed and persistent settings.
- `httpserver/` serves HTTP routes and health endpoints.
- `signaling/` implements WebSocket signaling and protocol validation.
- `meeting/` manages meeting and participant state.
- `webrtc/` and `media/` manage peer connections and RTP forwarding.

Browser pages and client code are in `web/` (`web/js/`, `web/css/`). Deployment
examples are in `deploy/`; operational and network-testing notes are in
`docs/`. Shell and Node-based checks are in `scripts/`.

## Build, Test, and Development Commands

Run the service locally with `go run .` and open `http://localhost:8080/`.
Copy `.env.example` to `.env` before configuring passwords, STUN/TURN, or
runtime limits.

```sh
go test ./...          # Run all Go unit and integration tests
go build ./...        # Compile every package
./scripts/smoke.sh     # Exercise the local HTTP service
node scripts/test-protocol.js
node scripts/test-adaptation.js
```

Use `docker compose up -d --build` to test the containerized deployment.
Run `gofmt` on changed Go files before submitting changes.

## Coding Style & Naming Conventions

Follow standard Go formatting and idioms: tabs as produced by `gofmt`,
`PascalCase` exported identifiers, and short `camelCase` locals. Keep package
names lowercase and focused. JavaScript uses the existing project style:
semicolons, single-quoted strings where already established, and descriptive
camelCase names. Keep browser behavior changes localized to the relevant
HTML, CSS, or JS module.

## Testing Guidelines

Add or update tests beside the implementation using Go’s `testing` package;
name them `Test<Behavior>` and table-test related cases where useful.
Media and WebRTC changes should include the narrowest relevant integration
coverage. Run `go test ./...` plus applicable scripts before opening a PR.

## Commit & Pull Request Guidelines

Recent commits use concise Conventional Commit-style subjects such as
`feat: add tests and validations` and `feat: add screen sharing`. Use
`feat:`, `fix:`, `test:`, `docs:`, or `refactor:` with an imperative summary.

PRs should explain the user-visible or operational impact, identify
configuration or deployment changes, link the relevant issue when one exists,
and list verification commands. Include screenshots or short recordings for
UI changes, and call out WebRTC, security, or backward-compatibility risks.

## Security & Configuration

Never commit `.env` values, passwords, TURN credentials, or private keys.
Passwords must remain server-side and must not be logged or sent to the
frontend. Preserve WebSocket upgrade behavior and TLS requirements when
editing deployment examples.

# Local development rules

- You may run `gofmt -w` on Go files in this repository without asking.
- You may run read-only Go checks such as `go test` and `go vet`.
- Ask before network access, destructive commands, or changes outside this repository

## Bash Tooling
Prefer these; fall back silently if missing.
- Content search: `rg` (not `grep`); files: `fd` (not `find`)
- Avoid `find -exec` / `xargs` chains — prefer `fd -x` or `rg -l | xargs`
- Structural search/refactor: `ast-grep` (`sg`)
- JSON: `jq` · YAML/TOML: `yq`
- GitHub (PRs, issues, reviews, CI, releases): `gh` — never scrape github.com or call REST directly

@RTK.md
