# DiffsHub

A standalone Next.js viewer for GitHub diffs — PRs, commits, comparisons, and
patch URLs — rendered with `@pierre/diffs`. The public deployment lives at
[diffshub.com](https://diffshub.com).

## Self-hosting

DiffsHub can run against GitHub Enterprise Server (or github.com) with optional
"Sign in with GitHub" support. All configuration is via environment variables
read by the Next.js server; set them for both `next build` and `next start` (the
home page can be statically rendered at build time).

| Variable                                                      | Default                                                    | Purpose                                                                                                                          |
| ------------------------------------------------------------- | ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `DIFFSHUB_GITHUB_URL`                                         | `https://github.com`                                       | Base web URL of the GitHub instance to view diffs from, e.g. `https://github.example.com`.                                       |
| `DIFFSHUB_GITHUB_API_URL`                                     | `<base>/api/v3` (GHES) or `https://api.github.com`         | REST API root. Set `https://api.<host>` for GHES with subdomain isolation.                                                       |
| `DIFFSHUB_GITHUB_RAW_URL`                                     | `<base>/raw` (GHES) or `https://raw.githubusercontent.com` | Raw file content root. Set `https://raw.<host>` for GHES with subdomain isolation.                                               |
| `DIFFSHUB_GITHUB_CLIENT_ID` / `DIFFSHUB_GITHUB_CLIENT_SECRET` | unset                                                      | OAuth app credentials. When both are set, the token UI offers "Sign in with GitHub" in addition to pasting a PAT.                |
| `DIFFSHUB_PUBLIC_ORIGIN`                                      | request origin                                             | External origin used for the OAuth `redirect_uri` when the server sits behind a reverse proxy, e.g. `https://diffs.example.com`. |
| `DIFFSHUB_GITHUB_TOKEN` (or `GITHUB_TOKEN` / `GH_TOKEN`)      | unset                                                      | Server-side fallback token for raw file hydration when a request carries no user token.                                          |

### Enabling "Sign in with GitHub"

1. On your GitHub instance, create an **OAuth app** (Settings → Developer
   settings → OAuth apps) with the authorization callback URL set to
   `https://<your-diffshub-host>/api/auth/github/callback`.
2. Set `DIFFSHUB_GITHUB_CLIENT_ID` and `DIFFSHUB_GITHUB_CLIENT_SECRET` from the
   app's credentials, and `DIFFSHUB_PUBLIC_ORIGIN` if DiffsHub runs behind a
   proxy.

The flow requests the classic `repo` scope (OAuth apps have no read-only repo
scope). The resulting user token is stored only in the browser's localStorage —
the same slot used when pasting a PAT — and is sent to the DiffsHub server
solely as a bearer header on diff-loading requests, which forward it to the
configured GitHub instance.
