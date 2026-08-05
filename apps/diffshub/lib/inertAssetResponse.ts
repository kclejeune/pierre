// Streams a proxied GitHub asset to the browser with the hardening headers
// shared by every asset proxy route. The CSP/sandbox/nosniff set mirrors
// raw.githubusercontent.com's defenses so a crafted file (e.g. an SVG with
// scripts) opened from this origin stays inert; keeping it in one place means
// tightening it tightens every proxy at once.
export function createInertAssetResponse(upstream: Response): Response {
  return new Response(upstream.body, {
    headers: {
      'Content-Type':
        upstream.headers.get('content-type') ?? 'application/octet-stream',
      // The refs behind a diff can move (the server re-resolves them every
      // few minutes), so keep browser caching short.
      'Cache-Control': 'private, max-age=300',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}
