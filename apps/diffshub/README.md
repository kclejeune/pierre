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
configuration is runtime-only: container builds (`NEXT_OUTPUT=standalone`)
render every page at request time, so no `DIFFSHUB_*` value is baked into the
image and changing `.env` only needs a container restart, not a rebuild.

If instead you build manually with Next's default output (no
`NEXT_OUTPUT=standalone`), the home page is statically prerendered — set the
environment variables for both `next build` and `next start` in that case.

| Variable                                                      | Default                                                    | Purpose                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DIFFSHUB_GITHUB_URL`                                         | `https://github.com`                                       | Base web URL of the GitHub instance to view diffs from, e.g. `https://github.example.com`.                                                                                                                                                                                                                                                                    |
| `DIFFSHUB_GITHUB_API_URL`                                     | `<base>/api/v3` (GHES) or `https://api.github.com`         | REST API root. Set `https://api.<host>` for GHES with subdomain isolation.                                                                                                                                                                                                                                                                                    |
| `DIFFSHUB_GITHUB_RAW_URL`                                     | `<base>/raw` (GHES) or `https://raw.githubusercontent.com` | Raw file content root. Set `https://raw.<host>` for GHES with subdomain isolation.                                                                                                                                                                                                                                                                            |
| `DIFFSHUB_GITHUB_CLIENT_ID` / `DIFFSHUB_GITHUB_CLIENT_SECRET` | unset                                                      | GitHub App or OAuth App credentials. The public client id enables the "Sign in with GitHub" UI; the secret is needed server-side to complete sign-in.                                                                                                                                                                                                         |
| `DIFFSHUB_PUBLIC_ORIGIN`                                      | request origin                                             | External origin used for the OAuth `redirect_uri` when the server sits behind a reverse proxy, e.g. `https://diffs.example.com`.                                                                                                                                                                                                                              |
| `DIFFSHUB_REQUIRE_LOGIN`                                      | on for self-hosted instances, off for github.com           | `1`/`true` requires credentials: visitors without a saved token are redirected to `/login` (GitHub sign-in or PAT) and returned to their original URL afterward, and the API routes refuse tokenless requests. `0`/`false` leaves the deployment open to anonymous visitors, which on github.com means public repositories at the unauthenticated rate limit. |

The server holds no GitHub credential of its own. Every upstream request is made
with the viewer's token — the one they signed in with or pasted — or anonymously
when the viewer has none, so GitHub makes every authorization decision against
the viewer's own access. On a self-hosted instance, where nothing is readable
anonymously, login is therefore required by default.

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
