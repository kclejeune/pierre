// GitHub answers both "you may not do this" and "you have asked too often"
// with 403, so status alone cannot tell an authorization failure from a
// throttled one. The signals that distinguish them live in the headers:
// a primary rate limit exhausts x-ratelimit-remaining, and a secondary
// (abuse) limit sends retry-after without touching the quota counter.
export function isGitHubRateLimitResponse(
  response: Response,
  detail?: string
): boolean {
  if (response.status !== 403 && response.status !== 429) {
    return false;
  }
  return (
    response.headers.get('x-ratelimit-remaining') === '0' ||
    response.headers.get('retry-after') != null ||
    (detail != null && /rate limit/i.test(detail))
  );
}
