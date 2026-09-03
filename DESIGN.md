---
name: LowMeet Operations Cockpit
version: 1.1
colors:
  canvas: '#eef2f5'
  surface: '#ffffff'
  surface-raised: '#f7f9fb'
  surface-inverse: '#17202a'
  text: '#17202a'
  text-muted: '#68737d'
  border-subtle: '#d9e1e7'
  primary: '#1769aa'
  primary-hover: '#125889'
  primary-soft: '#e5f1fa'
  success: '#287a45'
  success-soft: '#e8f5ed'
  warning: '#a36e20'
  warning-soft: '#fff4df'
  danger: '#b33b36'
  danger-soft: '#fdecea'
  inverse-text: '#d9e3ea'
typography:
  display:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontWeight: 700
    lineHeight: 1.15
  body:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: 'system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    fontWeight: 600
    lineHeight: 1.3
  data:
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'
    fontWeight: 600
    lineHeight: 1.3
rounded:
  control: '0.35rem'
  card: '0.5rem'
  panel: '0.75rem'
  pill: '999px'
spacing:
  base: '4px'
  xs: '4px'
  sm: '8px'
  md: '16px'
  lg: '24px'
  xl: '32px'
layout:
  maxWidth: '1200px'
  railWidth: '224px'
  contentMinWidth: '280px'
  touchTarget: '44px'
---

# LowMeet Operations Cockpit

## Product context

LowMeet is a small, self-hosted single-meeting WebRTC/SFU service. Its promise is
usable audio and graceful video degradation on slow or unstable connections.
The admin interface is an operator tool for one deployment, not a multi-tenant
analytics product.

The primary audience is the person who deploys and maintains LowMeet. They may
be checking the service from a laptop during a live call, or from a phone while
troubleshooting a remote installation. They need confidence and fast answers,
not a wall of infrastructure terminology.

The single job of the dashboard is: **show whether this LowMeet instance is
healthy, explain the current meeting conditions, and make safe runtime policy
changes.**

## Brand and style

The visual identity is a quiet operations cockpit: calm, compact, and readable
under pressure. LowMeet should feel dependable rather than enterprise-heavy.
Use the existing blue, white, cool-gray, and dark-diagnostics language as the
starting point, then make the roles and states consistent.

The interface should communicate:

- **Clarity:** one primary action per area, sentence-case labels, direct status
  language, and values that can be understood without a chart.
- **Resilience:** degraded conditions are visible and explained without panic.
  Audio health should not be visually buried under video warnings.
- **Control:** settings show their active value, validation range, save state,
  and operational consequence.
- **Respect for the operator:** no decorative gradients, fake precision,
  excessive animation, or unexplained abbreviations.

The memorable design signature is a **signal rail**: a narrow vertical status
rail beside the page content that changes from `success` to `warning` or
`danger` according to readiness and current network conditions. It gives an
operator an ambient health cue while the content remains data-first. The rail
must always have a text label and must never be the only status signal.

## Colors

Tokens are named by role so their purpose remains stable if the palette changes.

- `canvas` is the page background. It separates the dashboard from white
  content surfaces and preserves the existing LowMeet visual language.
- `surface` is the default card and form background. Use it for primary reading
  areas, never for full-viewport decoration.
- `surface-raised` is for secondary controls, table rows, and selected-but-not-
  active regions.
- `surface-inverse` is reserved for diagnostics, raw metric output, and dense
  technical readouts. Pair it with `inverse-text`.
- `primary` is for the main action, selected navigation, links, and focused
  controls. Use `primary-hover` only for interaction feedback.
- `primary-soft` marks selected navigation or informational emphasis without
  turning an entire panel blue.
- `success`, `warning`, and `danger` communicate operational state. Always pair
  them with a word, icon, or shape; never rely on color alone.
- `border-subtle` separates related regions without making the dashboard feel
  like a grid of boxes.
- `text-muted` is for metadata and supporting explanation. Do not use it for
  required labels or values that must be quickly scanned.

Do not introduce one-off colors for individual cards, metrics, or statuses.
Do not use `danger` for ordinary degraded network quality; use `warning` when
the service is still usable and reserve `danger` for failure or unavailable
states.

## Typography

Use the existing system sans-serif stack for dependable rendering on a
self-hosted product with no font download dependency. This keeps the dashboard
fast on the same constrained networks LowMeet is designed to tolerate.

- `display` is for the page title and major section headings. Use it sparingly.
- `body` is for descriptions, help text, and status explanations.
- `label` is for form labels, navigation items, table headers, and button text.
- `data` is for metric values, bitrate/FPS values, timestamps, endpoint names,
  and diagnostics. Use tabular-looking alignment and avoid decorative
  oversized numerals.

Recommended scale:

| Role | Size | Token |
| --- | ---: | --- |
| Page title | 28px | `display` |
| Section heading | 20px | `display` |
| Card metric | 24px | `data` |
| Body | 16px | `body` |
| Label/control | 14px | `label` |
| Metadata/diagnostic | 12–13px | `body` or `data` |

Use sentence case everywhere. Prefer “Active participants” to “ACTIVE
PARTICIPANTS” and “Save settings” to “Submit.”

## Layout and responsive behavior

The desktop layout has three zones:

```text
┌──── signal rail ────┬──── navigation rail ────┬──────── content ────────┐
│ Service ready       │ LowMeet                 │ Overview                │
│                     │                         │ [title] [refresh]       │
│                     │ Overview                │                         │
│                     │ Meeting settings        │ [health summary]        │
│                     │ Media policy            │ [metric] [metric] ...   │
│                     │ Network health           │                         │
│                     │ Service status          │ [active meeting panel]  │
│                     │                         │ [configuration summary] │
└─────────────────────┴─────────────────────────┴─────────────────────────┘
```

- On desktop, use `layout.maxWidth` for the content frame and keep the signal
  rail visually continuous with the navigation.
- On tablet, collapse the navigation rail to a labeled top navigation or a
  compact menu. Keep the signal status visible.
- On narrow screens, stack cards into one column, make tables horizontally
  scrollable, and keep action buttons at least `layout.touchTarget` high.
- Never allow the main content to become narrower than
  `layout.contentMinWidth`; overflow technical values instead of truncating
  them silently.
- Use the spacing scale in multiples of `spacing.base`. Use `spacing.lg` or
  `spacing.xl` between major regions and `spacing.sm` or `spacing.md` within
  cards.
- Cards group information by operator task, not by arbitrary visual variety.
  Avoid a dashboard made entirely of equal-sized tiles.

## Information architecture

### Overview

The default landing page answers current health questions in under five
seconds:

1. Page title, last refreshed time, and a manual refresh action.
2. Signal rail and service/readiness summary.
3. Active participants against `max_participants`.
4. Peer connections, reconnects, and connection failures.
5. Latest RTT, packet loss, jitter, video bitrate, and audio bitrate.
6. Current media policy summary.
7. Operator quick actions: refresh status, open the meeting, copy safe
   diagnostics, and jump to settings.
8. A compact recent-events strip for meaningful operational changes.

Use the current `/health`, `/ready`, `/metrics`, and `/admin/config` endpoints
where their data is available. Do not imply historical trends when the server
only exposes counters and latest samples.

### Meeting settings

Expose the current runtime settings already supported by `/admin/config`:

- Maximum participants.
- Default video quality.
- Maximum video bitrate.
- Maximum video FPS.
- Maximum audio bitrate.
- Screen sharing enabled/disabled.

Group settings by consequence:

- **Capacity:** maximum participants.
- **Video policy:** default quality, maximum bitrate, maximum FPS.
- **Audio policy:** maximum audio bitrate.
- **Meeting features:** screen sharing.

Show valid ranges and units beside numeric inputs. Explain that participant
capacity changes apply to the active meeting state and that media policy changes
are broadcast to connected clients.

The admin password is an authentication input, not a configurable dashboard
setting. Never display, persist, echo, or include it in a status summary.

### Media policy

This may initially be a focused section within Meeting settings. Use plain
language to explain the relationship between quality, bitrate, FPS, and
degradation. The dashboard should preserve LowMeet’s principle that audio
remains usable as video degrades.

### Network health

Present the latest network sample as a diagnostic panel with:

- RTT and average RTT when available.
- Packet loss.
- Jitter.
- Video bitrate.
- Audio bitrate.
- Number of network samples.

Use explicit units (`ms`, `%`, `kbps`) and show “No sample yet” when a value is
not available. A warning state should explain the operational meaning, for
example: “Video may reduce quality while audio remains available.”

Historical charts are out of scope until the backend provides time-series data.

### Recent events

Show a short, newest-first event list rather than a full audit log. The first
version may derive events from client-observed transitions and save responses:

- Settings saved.
- Service became ready or unavailable.
- Metrics became stale or recovered.
- Reconnects crossed the warning threshold.

Each event includes a plain-language label and timestamp. Do not claim that the
list is a durable audit history until the server persists events. If no events
are available, show: “No recent events.”

### Service status

Show readiness and deployment context without exposing secrets:

- Service health.
- Readiness.
- Runtime environment if deliberately exposed by the server.
- Config persistence status if the backend exposes it.
- Public endpoints relevant to operation: `/`, `/health`, `/ready`,
  `/metrics`, and `/ws`.

Do not display TURN passwords, meeting passwords, admin passwords, private
keys, or full environment contents.

## Components

### Navigation and signal rail

Navigation uses a quiet `surface` background, a `border-subtle` divider, and
`primary-soft` for the selected item. Each item has a text label and may have a
small semantic icon. Do not use icons without labels.

The signal rail contains:

- A short status label such as “Service ready,” “Network watch,” or
  “Unavailable.”
- A matching status indicator.
- The last refresh time or a refresh control when space allows.

States:

- Default: neutral `border-subtle` rail.
- Ready: `success` indicator and `success-soft` supporting background.
- Degraded: `warning` indicator and a short explanation.
- Failure: `danger` indicator and a recovery-oriented message.
- Loading: stable rail with a subtle progress treatment; do not make the whole
  navigation jump.

### Metric cards

Metric cards contain one value, one label, one unit if needed, and optional
supporting context. Keep the label above or beside the value, not hidden in a
tooltip.

Good examples:

- `3 / 5` — Active participants
- `42 ms` — Latest RTT
- `1.2%` — Packet loss
- `2` — Reconnects

States:

- Default: `surface`, subtle border, no heavy shadow.
- Positive: use `success` only when the value clearly indicates healthy
  operation.
- Warning: use `warning` plus explanatory text.
- Unavailable: use “No sample yet,” never `0` when zero is unknown.
- Loading: preserve the card’s size and use a restrained placeholder.
- Error: state what could not be read and offer “Try again” where appropriate.

### Configuration forms

Use one-column forms on mobile and two-column grouped forms on wide layouts
when labels remain directly associated with controls.

- Every control has a visible label.
- Help text explains the operational effect, not implementation details.
- Number inputs include min/max constraints and units.
- Toggles state their resulting behavior, such as “Allow screen sharing.”
- Do not use placeholder text as the only label.
- Keep the save action at the end of the related group or in a sticky save bar
  on long forms.

Form states:

- Default: clear label, value, and optional help text.
- Focus-visible: at least a 2px `primary` outline with sufficient contrast.
- Invalid: `danger` styling, specific correction text, and focus moved only
  when submitting if the browser can do so accessibly.
- Saving: disable duplicate submission and change the action to “Saving…”.
- Saved: keep values visible and announce “Settings saved.”
- Save failure: preserve entered values and explain whether the server rejected
  the input or could not be reached.
- Unsaved changes: show a clear “Unsaved changes” indicator and confirm before
  leaving only when data would be lost.

### Buttons

Primary buttons use `primary` with white text and are reserved for the main
action, usually “Save settings” or “Refresh.” Secondary buttons use a
`surface-raised` or outlined treatment. Destructive actions use `danger` only
when the action itself is destructive; do not use it for ordinary validation.

Every button must define:

- Default.
- Hover.
- Active/pressed.
- Focus-visible.
- Disabled.
- Loading.
- Success or completion feedback where applicable.

Buttons retain the same verb through the complete flow: “Save settings” leads
to “Settings saved,” and “Refresh” leads to “Updated just now.”

### Status messages and toasts

Prefer inline messages next to the affected region. Use a toast only for a
short-lived result that does not need user action.

- Success: “Settings saved.”
- Warning: “Metrics are stale: last sample 2 minutes ago.”
- Error: “Settings could not be saved. Check the values and try again.”
- Empty: “No active participants. The next person to join will appear here.”

Messages must use `role="status"` for non-blocking updates and an appropriate
alert mechanism for failures that require immediate attention. Do not use
vague messages such as “Something went wrong.”

### Diagnostics panel

Use `surface-inverse`, `inverse-text`, and `data` typography for dense
technical output. Keep it visually distinct from normal operator guidance.

Show human-readable labels before raw metric names. Provide a copy action only
when it is genuinely useful, and ensure copied output does not contain
credentials or authentication headers.

### Tables and participant lists

Use a table only when multiple rows need comparison. For a small active meeting,
a stacked participant list is usually clearer. Include name, join time, and
connection/media state only when those values are available from the backend.

Do not invent per-participant RTT, packet loss, or moderation controls until
the server exposes them.

## Interaction and data rules

- Poll or refresh operational data at a modest interval appropriate for an
  admin page. Avoid aggressive polling that competes with live WebRTC traffic.
- Show the timestamp of the latest data and distinguish “zero” from “unknown.”
- Keep the dashboard usable when `/metrics` is unavailable; settings and
  service status should fail independently.
- Refresh each data source independently and show its own loading, stale, retry,
  and error state. One failed request must not blank the whole dashboard.
- Treat `401 Unauthorized`, invalid configuration, and network failures as
  distinct messages.
- Preserve entered form values after a failed save.
- Never log or render the `X-Admin-Password` value.
- Use `Cache-Control: no-store` semantics for sensitive admin responses.
- Keep `/metrics` raw output behind the deployment’s existing access-control
  boundary; do not expose it as a public dashboard data source without
  considering information disclosure.
- Respect the existing TLS and WebSocket deployment requirements. The admin
  page must work behind Caddy or Nginx without changing upgrade behavior.

## Public meeting experience

The public page has two intentional states:

1. **Join:** a quiet welcome surface with one clear action, short explanations
   of audio-first resilience, the name and optional meeting password fields,
   and an optional temporary camera/microphone check.
2. **Meeting:** a focused room shell with connection state, participant media,
   bandwidth policy, diagnostics, and a persistent control area.

The brand bar and welcome grid are join-only framing. After the server confirms
the participant, hide both so the meeting shell can use the full public-page
width. Restore them when the participant leaves.

Meetings start with the microphone muted and camera off. The browser still
requests the available tracks so controls can be enabled immediately, but
their `enabled` state and the first `media_state` message must reflect the
safe defaults. Missing devices disable only the affected control and leave the
other media path usable.

The pre-join device check uses a short-lived local stream, shows a temporary
muted camera preview, reports camera and microphone readiness independently,
and stops every test track before socket connection. It must not record,
persist, or send the test stream.

The meeting view should make the current call the visual priority. Participant
tiles use the available video as the primary surface and expose media state as
text. A muted microphone and camera-off state also receive distinct tile
border treatments, while a speaking tile receives a success border and a
visible “Speaking now” label. The client may use Web Audio RMS analysis of
local and remote audio for this best-effort highlight; it must not claim that
the server has authoritative speaker detection. If Web Audio is unavailable,
media playback and the text media states remain fully usable.

Controls retain stable verbs and `aria-pressed` state:

- Mute or unmute microphone.
- Turn camera on or off.
- Pause or resume remote video.
- Start or stop screen sharing.
- Leave the meeting.

The public page must remain useful when media is degraded. Keep connection
state, audio availability, screen-share ownership, and effective bandwidth
profile visible without turning every warning into a blocking modal.

## Implementation constraints

- Use the existing system font stack; LowMeet is self-hosted and optimized for
  constrained networks.
- Use CSS custom properties for semantic color, spacing, radii, and focus
  treatments. Do not add one-off per-component colors.
- Keep the existing WebSocket protocol and REST endpoints unchanged.
- Preserve JavaScript-facing IDs in `web/index.html` and `web/admin.html`.
- Use text labels alongside any decorative indicator. Never use emoji as a
  structural control icon.
- Do not add historical charts, per-participant network claims, moderation
  controls, or credential-bearing diagnostics until the backend supports them.
- Verify the public meeting shell at 375px, tablet, and desktop widths, with
  keyboard focus and reduced motion enabled.

### Freshness and thresholds

Every live metric region shows when it was last updated. Use these states:

- **Fresh:** updated within the normal polling interval.
- **Stale:** no successful update for 2 polling intervals; show
  “Metrics are stale” and retain the last known value.
- **Unavailable:** no usable value has ever been received; show “No sample yet”
  rather than zero.
- **Recovered:** briefly announce that the source is current again.

The exact polling interval is an implementation choice, but it must be modest
and documented in the client. Thresholds must be role-based constants, not
colors embedded in components. Initial guidance:

- Capacity warning at 80% utilization.
- Capacity critical at 100%.
- Network warning when packet loss, RTT, or jitter exceeds a clearly labeled
  configured threshold.

Threshold copy must explain consequence, for example: “Video may reduce
quality while audio remains available.”

### Quick actions

The Overview quick-action group contains only safe, high-frequency actions:

- **Refresh status:** refetch health, readiness, metrics, and configuration.
- **Open meeting:** navigate to `/`.
- **Copy diagnostics:** copy a redacted support snapshot.
- **Edit settings:** navigate to Meeting settings.

Actions must retain stable labels and show completion feedback. Do not add
destructive meeting controls until the backend defines authorization,
confirmation, and participant-facing behavior.

### Safe diagnostics

“Copy diagnostics” produces a human-readable snapshot containing:

- Capture timestamp.
- Health and readiness state.
- Active participants and configured capacity.
- Latest metrics and freshness.
- Non-secret media settings.
- Client version or deployment identifier only if already exposed safely.

It must exclude admin passwords, meeting passwords, TURN credentials,
authentication headers, cookies, private keys, and raw environment variables.

### Authentication and administrator sessions

The current header-based admin password flow is acceptable only as the
smallest compatibility baseline. A production dashboard should migrate to:

- A dedicated login endpoint that establishes a secure, `HttpOnly`,
  `SameSite=Strict` session cookie.
- CSRF protection for state-changing requests.
- Login throttling or account lockout backoff.
- An explicit logout action that clears the session.
- Short, configurable session lifetime with renewal while active.
- Generic authentication errors that do not reveal whether an account exists.

Until that migration exists, the UI must clear the password field on logout or
session expiry, use HTTPS-only deployment guidance, avoid putting credentials
in URLs, and never retain the password in local storage, session storage, or
diagnostic output.

## Representative dashboard states

Future UI implementations should design these states as first-class screens,
not as afterthoughts:

### Healthy active meeting

```text
Service ready                         Updated 12 seconds ago
3 / 5 active participants             60% capacity

42 ms   Latest RTT       0.4%   Packet loss
8 ms    Jitter           410    Video kbps
32      Audio kbps       0      Connection failures

Recent events
Settings saved · 09:41
Participant reconnected · 09:38
```

### Near capacity

```text
Network watch                         Updated 8 seconds ago
4 / 5 active participants             Near capacity

One more participant will reach the configured limit.
[Edit settings]
```

Use `warning` with a text explanation. Do not make the entire page look like
an incident.

### Stale metrics

```text
Metrics are stale                     Last sample 2 minutes ago
The last known values are shown below. [Try again]
```

Retain last-known values with a visible stale marker. Never silently present
old data as current.

### Empty service

```text
No active participants
The next person to join will appear here.
[Open meeting] [Edit settings]
```

### Failed save

```text
Settings could not be saved
Maximum participants must be between 1 and 100.
Your other changes are still here.
```

Keep the form values and focus the first invalid field accessibly.

## Accessibility and motion

- Use semantic landmarks: navigation, main, headings, forms, sections, and
  lists/tables as appropriate.
- Maintain visible keyboard focus using `primary`; never remove outlines
  without providing an equivalent.
- Ensure controls meet `layout.touchTarget` on touch devices.
- Do not communicate readiness, degradation, or failure by color alone.
- Keep labels and descriptions associated through HTML semantics, not visual
  proximity alone.
- Use live regions for save results and refresh results.
- Support `prefers-reduced-motion: reduce`; remove nonessential transitions and
  never use flashing effects.
- Preserve readable contrast for muted text and disabled states; disabled
  controls may be subdued but must remain understandable.

## Content voice

Use short, direct, operational language:

- “Service ready”
- “Active participants”
- “Maximum participants”
- “Latest RTT”
- “Packet loss”
- “Screen sharing”
- “Save settings”
- “Settings saved”

Describe what the operator controls or observes, not the internal code path.
Use “Maximum video bitrate,” not “RTP ceiling,” unless the diagnostic context
requires the technical term. Explain abbreviations on first use.

## Out of scope for the first dashboard design

The following require backend or product changes and must not be represented as
already available:

- Multi-meeting or multi-tenant administration.
- User accounts, roles, or audit history.
- Historical metric charts and retention.
- Per-participant network telemetry.
- Participant removal, muting, or moderation actions.
- TURN/STUN credential editing.
- Secret rotation from the browser.
- Deployment, container, or host resource management.

These may be added later behind explicit APIs and security review.

## MVP boundary

Use this boundary to keep the first implementation small and coherent.

| Priority | Capability | Source |
| --- | --- | --- |
| Now | Overview health, readiness, capacity, latest metrics | Existing endpoints |
| Now | Runtime settings form with validation and save states | `/admin/config` |
| Now | Independent loading, stale, unavailable, and retry states | Client behavior |
| Now | Responsive layout, accessibility, and redacted diagnostics | Client behavior |
| Next | Dedicated dashboard data endpoint with timestamps | Backend addition |
| Next | Session-cookie authentication and CSRF protection | Backend/security addition |
| Next | Durable recent-events storage | Backend addition |
| Future | Historical charts, roles, audit history, moderation, multi-meeting | Product/backend additions |

Do not implement a feature from the `Next` or `Future` column as if it already
exists in the current API.

## Dashboard API contract

When a dedicated dashboard endpoint is introduced, prefer one response that
contains independently timestamped domains. The endpoint must not include
secrets.

```json
{
  "generated_at": "2026-09-02T12:00:00Z",
  "service": {
    "health": "ok",
    "ready": true
  },
  "meeting": {
    "active_participants": 3,
    "max_participants": 5
  },
  "metrics": {
    "updated_at": "2026-09-02T11:59:52Z",
    "peer_connections": 3,
    "connection_failures": 0,
    "reconnects": 2,
    "network_samples": 48,
    "average_rtt_ms": 42,
    "last_rtt_ms": 42,
    "last_packet_loss_percent": 0.4,
    "last_jitter_ms": 8,
    "last_video_kbps": 410,
    "last_audio_kbps": 32
  },
  "settings": {
    "max_participants": 5,
    "default_video_quality": "low",
    "max_video_bitrate": 500000,
    "max_video_fps": 30,
    "max_audio_bitrate": 64000,
    "screen_share_enabled": true
  }
}
```

Use ISO 8601 UTC timestamps, stable snake_case field names, explicit `null`
for unavailable values, and machine-readable error responses:

```json
{
  "error": {
    "code": "invalid_configuration",
    "message": "Maximum participants must be between 1 and 100.",
    "field": "max_participants"
  }
}
```

The current implementation may compose this view client-side from `/health`,
`/ready`, `/metrics`, and `/admin/config`. The UI must preserve the same
semantics while that transition is made.

## Design-to-code token map

Implement tokens as CSS custom properties at `:root`. Component styles must
reference variables rather than repeating literal values.

```css
:root {
  --color-canvas: #eef2f5;
  --color-surface: #ffffff;
  --color-surface-raised: #f7f9fb;
  --color-surface-inverse: #17202a;
  --color-text: #17202a;
  --color-text-muted: #68737d;
  --color-border-subtle: #d9e1e7;
  --color-primary: #1769aa;
  --color-primary-hover: #125889;
  --color-primary-soft: #e5f1fa;
  --color-success: #287a45;
  --color-warning: #a36e20;
  --color-danger: #b33b36;
  --radius-control: 0.35rem;
  --radius-card: 0.5rem;
  --radius-panel: 0.75rem;
  --space-unit: 4px;
  --touch-target: 44px;
}
```

Dark mode is limited to diagnostics and raw technical output in the first
version. Do not add a second full theme until contrast and state parity have
been tested.

## Responsive wireframes

### Desktop overview

```text
┌──────┬──────────────────────────────────────────────────────────────┐
│ rail │ Overview                         Updated 12s ago  [Refresh] │
│ nav  ├──────────────────────────────────────────────────────────────┤
│      │ [Service ready] [3 / 5 active] [2 reconnects] [0 failures]  │
│      │                                                              │
│      │ Network health                 Current policy                │
│      │ RTT · loss · jitter             Capacity · video · audio     │
│      │                                                              │
│      │ Recent events                   Quick actions                 │
│      │ Settings saved                  [Open meeting] [Copy data]   │
└──────┴──────────────────────────────────────────────────────────────┘
```

### Mobile overview

```text
┌─────────────────────────────┐
│ LowMeet       [Menu]        │
│ Service ready               │
├─────────────────────────────┤
│ Overview                    │
│ Updated 12s ago [Refresh]   │
│                             │
│ 3 / 5 active participants   │
│ 60% capacity                │
│                             │
│ RTT 42ms · Loss 0.4%        │
│ Jitter 8ms · Audio 32kbps   │
│                             │
│ [Open meeting]              │
│ [Copy diagnostics]          │
│ [Edit settings]             │
└─────────────────────────────┘
```

At 200% zoom, preserve reading order and allow horizontal scrolling only for
technical tables or raw diagnostics. Do not hide actions inside hover-only
menus.

## Permission boundaries

The first dashboard has two permission levels:

- **Observer:** read-only health, readiness, metrics, capacity, and settings
  summary.
- **Administrator:** observer access plus runtime settings changes.

The current password-protected admin route acts as administrator access. Until
separate sessions or roles exist, do not present an observer login as an
implemented capability. Future destructive actions require a separate
permission, explicit confirmation, audit event, and participant-facing
feedback.

## Operational thresholds

Keep thresholds centralized and label them in the UI. Initial defaults:

| Signal | Normal | Warning | Critical |
| --- | ---: | ---: | ---: |
| Capacity utilization | <80% | 80–99% | 100% |
| RTT | <150ms | 150–300ms | >300ms |
| Packet loss | <2% | 2–5% | >5% |
| Jitter | <30ms | 30–60ms | >60ms |
| Metrics age | <2 intervals | 2–5 intervals | >5 intervals |

These are operator cues, not claims about WebRTC failure. Always show the
actual value, unit, threshold meaning, and consequence. A critical network
signal should say what the operator can expect, such as “Video may be reduced;
audio is still being monitored.”

## Accessibility acceptance gates

An admin dashboard implementation is not complete until all of the following
pass:

- Complete Overview and Settings flows using keyboard only.
- Visible focus remains present on every interactive element.
- Screen readers announce refresh completion, save success, stale data, and
  actionable errors.
- Status remains understandable without color or icons.
- Text and controls remain usable at 200% browser zoom.
- Layout remains usable at narrow mobile width without clipped labels.
- Touch targets are at least `layout.touchTarget`.
- `prefers-reduced-motion` removes nonessential transitions.
- Validation identifies the field, the problem, and the correction.
- Error and stale states preserve the last useful context.

## Implementation roadmap

1. Refactor `web/admin.html` into Overview and Settings regions while retaining
   the existing `/admin/config` flow.
2. Move shared visual values into CSS variables based on the token map.
3. Add independent client refresh state for health, readiness, metrics, and
   settings.
4. Add capacity visualization, quick actions, safe diagnostics copy, and
   representative empty/error states.
5. Add a dedicated dashboard response with timestamps and structured errors.
6. Replace header-password persistence with secure sessions and CSRF protection.
7. Add durable events only after storage, retention, and access rules are
   defined.

## Avoid

- Generic SaaS dashboard decoration, gradients, oversized hero numbers, or
  decorative charts without historical data.
- One giant card containing every setting and metric.
- Status conveyed only through red, yellow, or green.
- Zero values used when a metric is unknown or has never been sampled.
- Loading spinners that resize the page or block unrelated sections.
- Hover-only controls, icon-only buttons, or placeholder-only labels.
- Browser storage, URLs, logs, clipboard output, or analytics containing
  passwords or credentials.
- Claims of per-participant diagnostics, historical trends, audit history,
  moderation, or multi-meeting support before APIs exist.

## Test scenarios

Add implementation tests for these scenarios:

- `/health` succeeds while `/metrics` fails; health remains visible and metrics
  shows an independent retry state.
- Metrics stop updating; the last value remains visible with a stale timestamp.
- A metric has no sample; the UI displays “No sample yet,” not `0`.
- Active participants reach 80% and 100% capacity; warning and critical copy
  appears with an accessible text alternative.
- `/admin/config` returns `401`; the password field clears and no credentials
  appear in the DOM, URL, storage, or diagnostics.
- Configuration validation fails; the invalid field is identified and other
  entered values remain unchanged.
- Save succeeds; the UI announces “Settings saved” and displays the updated
  value.
- Save fails due to a network error; the form remains editable and offers retry.
- Copied diagnostics contain expected health and metrics fields but none of the
  known secret names or values.
- Keyboard navigation, reduced motion, narrow layout, and 200% zoom preserve
  access to every required action.

## Implementation checklist

Before considering an admin UI implementation complete, verify:

- The overview uses the existing health, readiness, metrics, and admin-config
  data without fabricating unavailable values.
- Data sources refresh independently and expose fresh, stale, unavailable,
  recovered, and retry states.
- Capacity uses both an exact fraction and an accessible utilization message.
- Quick actions are safe, labeled, keyboard reachable, and provide completion
  feedback.
- Copied diagnostics are redacted by construction and tested against known
  secret fields.
- Authentication behavior does not store credentials in browser storage and
  clearly identifies the current header-based flow as transitional.
- Every token is used by role and has a documented boundary.
- Configuration fields show units, ranges, validation, and save status.
- Loading, empty, unavailable, validation-error, and server-error states exist.
- Buttons and controls define hover, active, disabled, loading, and focus states.
- Keyboard navigation, focus visibility, live announcements, and reduced motion
  work.
- The layout remains usable on a narrow screen and with long metric values.
- No password, token, TURN credential, or private deployment value reaches the
  rendered interface or client logs.
- Visual changes stay localized to the admin surface and preserve the public
  meeting experience.
