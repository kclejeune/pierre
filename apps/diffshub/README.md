# DiffsHub

A standalone Next.js viewer for GitHub diffs — PRs, commits, comparisons, and
patch URLs — rendered with `@pierre/diffs`. The public deployment lives at
[diffshub.com](https://diffshub.com).

## Self-hosting

DiffsHub can run against GitHub Enterprise Server (or github.com) with optional
"Sign in with GitHub" support. It is not a static site — diff streaming, file
hydration, and OAuth are server-side route handlers — so it runs as a Next.js
Node server.

The quickest path is Docker. From the repo root, export the `DIFFSHUB_*`
variables you need (all optional; defaults target public github.com) and run:

```bash
docker compose up --build
```

The app listens on `localhost:3692` (override with `DIFFSHUB_PORT`). All
configuration is runtime-only: every page is rendered per request, so no
`DIFFSHUB_*` value is baked into the image or hosted build before secrets are
available. Changing `.env` only needs a server restart, not a rebuild.

| Variable                                                      | Default                                                    | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `DIFFSHUB_GITHUB_URL`                                         | `https://github.com`                                       | Base web URL of the GitHub instance to view diffs from, e.g. `https://github.example.com`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DIFFSHUB_GITHUB_API_URL`                                     | `<base>/api/v3` (GHES) or `https://api.github.com`         | REST API root. Set `https://api.<host>` for GHES with subdomain isolation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `DIFFSHUB_GITHUB_RAW_URL`                                     | `<base>/raw` (GHES) or `https://raw.githubusercontent.com` | Raw file content root. Set `https://raw.<host>` for GHES with subdomain isolation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `DIFFSHUB_GITHUB_CLIENT_ID` / `DIFFSHUB_GITHUB_CLIENT_SECRET` | unset                                                      | GitHub App or OAuth App credentials. The public client id enables the "Sign in with GitHub" UI; the secret is needed server-side to complete sign-in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `DIFFSHUB_PUBLIC_ORIGIN`                                      | request origin                                             | External origin used for the OAuth `redirect_uri` when the server sits behind a reverse proxy, e.g. `https://diffs.example.com`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `DIFFSHUB_REQUIRE_LOGIN`                                      | on for self-hosted instances, off for github.com           | `1`/`true` requires credentials: visitors without a saved token are redirected to `/login` (GitHub sign-in or PAT) and returned to their original URL afterward, and the API routes refuse tokenless requests. `0`/`false` leaves the deployment open to anonymous visitors, which on github.com means public repositories at the unauthenticated rate limit.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `DIFFSHUB_ENABLE_PAT_INPUT`                                   | off when login is required and OAuth is configured         | Whether the UI offers the manual PAT paste box and token-creation links. `0`/`false` hides them everywhere, leaving "Sign in with GitHub" as the only offered auth method; `1`/`true` forces them on unless token encryption is enabled. When unset, a require-login deployment with OAuth configured hides the box (PATs stay out of localStorage); without OAuth it stays on, since a PAT is then the only way through the login gate. `DIFFSHUB_TOKEN_ENCRYPTION_KEY` always hides the box because the server rejects unsealed credentials.                                                                                                                                                                                                                                                                     |
| `DIFFSHUB_REFRESH_TOKEN_MAX_TTL`                              | unset (GitHub's six months)                                | Maximum absolute session age, e.g. `86400`, `24h`, or `7d`: every viewer must complete a full GitHub reauthorization at least that often, however active they are. Server-enforced — refresh tokens leave the server wrapped and MAC'd with the original sign-in time (keyed by the client secret, so rotating the secret invalidates all outstanding sessions), and the refresh route rejects older sessions. `0` omits refresh tokens entirely, forcing reauthorization once each short-lived (8h) access token expires. Unset leaves GitHub's six-month inactivity window. Setting or changing the value signs existing sessions out once. Only meaningful for GitHub Apps with token expiration enabled.                                                                                                       |
| `DIFFSHUB_TOKEN_ENCRYPTION_KEY`                               | unset (tokens stored in the clear)                         | Opt-in at-rest encryption of the credentials the browser stores: 32 base64-encoded bytes, e.g. `openssl rand -base64 32`. When set, OAuth access and refresh tokens leave the server sealed into AES-256-GCM envelopes, so localStorage (and its backups) holds only ciphertext GitHub never accepts directly; the API routes decrypt on arrival. Enabling or rotating the key signs out existing sessions whose credentials are bare or sealed under another key, forcing a fresh OAuth login. Manual PATs are incompatible with this policy.                                                                                                                                                                                                                                                                     |
| `DIFFSHUB_AVATAR_TOKEN`                                       | unset (avatars use the viewer's token)                     | Classic GitHub token used for nothing but GHES avatar lookups. GHES gates its avatar API on a classic OAuth scope (`read:user` is enough) and exposes no equivalent GitHub App permission, so a viewer signed in through a GitHub App cannot load avatars with their own token — the request 404s and the UI falls back to author initials. Fine-grained PATs use the permission model and so do not work either. Prefer a dedicated machine account, since classic scopes are bounded by what that account can already see. Pair it with `DIFFSHUB_TOKEN_ENCRYPTION_KEY`, which makes the "caller presented a credential we could resolve" check a real one. Unset, blank, or rejected by the instance, avatars fall back to the viewer's token and then to initials, so a bad value degrades rather than breaks. |

Every upstream request is made with the viewer's token — the one they signed in
with or pasted — or anonymously when the viewer has none, so GitHub makes every
authorization decision against the viewer's own access. On a self-hosted
instance, where nothing is readable anonymously, login is therefore required by
default.

`DIFFSHUB_AVATAR_TOKEN` is the sole exception, and only when set: GHES will not
serve avatars to a GitHub App token at all. A profile image is not
viewer-specific, so a shared credential discloses nothing the viewer could not
already see. No other request ever uses it.

### Logs

At startup the process logs how it is configured, so a container's first log
line answers "what did it actually read?" without shelling in. Non-secret
variables print their value, configured secrets print `*****`, and anything
unset prints `null`. An `effective` object carries the resolved instance URLs
and credential policies, since most `DIFFSHUB_*` defaults are derived rather
than literal. This record is indented and carries none of the `event`/`time`/
`level` fields the request logs use, so it reads as a startup banner rather than
another entry; a malformed configuration prints the same record with
`effectiveError` on stderr:

```json
{
  "env": {
    "DIFFSHUB_GITHUB_URL": "https://ghe.corp.dev",
    "DIFFSHUB_GITHUB_API_URL": null,
    "DIFFSHUB_GITHUB_CLIENT_SECRET": "*****",
    "DIFFSHUB_AVATAR_TOKEN": "*****"
  },
  "effective": {
    "apiURL": "https://ghe.corp.dev/api/v3",
    "requireLogin": true,
    "patInputEnabled": false
  }
}
```

Every API request is logged to stdout as one JSON object per line, and failures
go to stderr, so `docker logs`, `kubectl logs`, and `wrangler tail` stream them
with no extra configuration:

```bash
docker compose logs -f diffshub | grep api_request
```

```text
{"time":"...","event":"api_request","method":"GET","path":"/api/github-web-asset","durationMs":26,"level":"info","status":200}
```

`level` is `info` below 400, `warn` for a 4xx, and `error` for a 5xx. A request
whose handler throws also carries `error` and `stack`. `/api/health` is the one
route not logged — it is polled continuously and always answers 200.

`github_upstream_failure` lines include the sanitized upstream URL, the
credential kind when known (`viewer`, `deployment-avatar`, or `none`), and
response headers that explain a refusal. These include `x-github-request-id`,
which can be quoted in a GHES support ticket, and the scope and permission
headers that distinguish a missing scope from an endpoint unavailable to that
credential type.

```bash
docker compose logs -f diffshub | grep github_upstream_failure
```

Query-string values are redacted, since avatar lookups carry an email address
and redirected asset URLs carry signed download tokens. Credentials are never
logged.

### Health check

`GET /api/health` returns `200 {"status":"ok"}` without touching GitHub or the
login gate, for ECS/ALB target groups, App Runner, and similar probes. Don't
point a probe at `/`: with `DIFFSHUB_REQUIRE_LOGIN` on it redirects to `/login`,
which most load balancers count as unhealthy.

### Enabling "Sign in with GitHub"

Sign-in uses the standard OAuth web flow, which works with either app type:

- **GitHub App** (recommended for Github Enterprise deployments): create one
  under Settings → Developer settings → GitHub Apps with the callback URL
  `https://<your-diffshub-host>/api/auth/github/callback` and the repository
  permissions **Contents: Read and write** and **Pull requests: Read and write**
  (Metadata: Read is added automatically). Webhooks are not needed. _Expire user
  authorization tokens_ may stay enabled: the browser keeps the refresh token
  alongside the access token and renews it through `/api/auth/github/refresh`
  before the eight-hour lifetime runs out, for as long as the six-month refresh
  token is valid. Then install the app on every organization (and any user
  account) whose repositories should be viewable, with access to all
  repositories: a GitHub App sign-in can only reach repositories where the app
  is installed, and a repository outside the installation surfaces as "cannot
  access" even though the user has access on GitHub.
- **OAuth App**: create one under Settings → Developer settings → OAuth apps
  with the same callback URL. The flow requests the classic `repo` scope (OAuth
  apps have no read-only repo scope); GitHub Apps ignore that parameter. On
  instances with OAuth app access restrictions each organization must approve
  the app separately.

Either way, set `DIFFSHUB_GITHUB_CLIENT_ID` and `DIFFSHUB_GITHUB_CLIENT_SECRET`
from the app's credentials, and `DIFFSHUB_PUBLIC_ORIGIN` if DiffsHub runs behind
a proxy.

The resulting user token is stored only in the browser's localStorage — the same
slot used when pasting a PAT — and is sent to the DiffsHub server solely as a
bearer header on GitHub-bound requests (diff loading, review comments), which
forward it to the configured GitHub instance. An expiring token's refresh token
lives next to it and is sent only to the refresh route; the server holds no
session state of its own.

## Review comments

On pull-request views, DiffsHub shows the PR's existing review threads inline
(author, avatar, age) and in the sidebar comment list. With a saved token you
can reply to a thread, post new line comments from the gutter `+` (they are
created as real GitHub review comments against the PR head), and edit or delete
your own comments. Posting requires a token with write access to pull requests —
a GitHub App or fine-grained PAT with Pull requests: Read and write, or an OAuth
App / classic PAT with the `repo` scope. Without a token (or outside PR views),
comments stay local to the browser session.

Markdown files in a diff get a book icon in their file header that toggles a
rendered view of the document above the diff, with changed sections marked in
the margin; hovering a section reveals a `+` that opens a draft comment on the
matching source line. The rendered view matches GitHub's markdown rendering:
` ```mermaid ` fences render as diagrams, embedded HTML (image tags,
`<details>`, …) is sanitized against the GitHub schema, and relative image
references are served from the repository at the diff's revision through a
server-side proxy, as are assets the instance itself hosts (comment-author
avatars and pasted user-attachment images on private-mode GHES). All of these
load with the viewer's own token; for anonymous visitors on github.com only
public-repository assets render.
