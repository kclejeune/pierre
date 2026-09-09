import { getAvatarLookupToken } from './githubEnvironment';
import { isGitHubRateLimitResponse } from './githubRateLimit';
import { isImageResponse } from './inertAssetResponse';

// Which credential pays for a GHES avatar lookup — the one upstream request a
// viewer signed in through a GitHub App cannot make with their own token (see
// GitHubWebAssetUpstream.isAvatarLookup), so a deployment may configure
// DIFFSHUB_AVATAR_TOKEN to pay for it.

const REFUSAL_TTL_MS = 60_000;

let refusedUntil = 0;

// Undefined means "use the viewer's own token".
//
// Only lent to a caller whose sealed credential was opened successfully. Bare
// PATs remain valid viewer credentials when encryption is disabled, but they
// do not prove that DiffsHub issued the session and cannot borrow this token.
export function resolveAvatarCredential(
  viewerToken: string | undefined,
  viewerCredentialVerified: boolean,
  now: number = Date.now()
): string | undefined {
  if (viewerToken == null || !viewerCredentialVerified || now < refusedUntil) {
    return undefined;
  }
  const avatarToken = getAvatarLookupToken();
  // Same credential means no fallback to make, so report none.
  return avatarToken === viewerToken ? undefined : avatarToken;
}

// Suppresses the credential briefly so a rejected token costs one upstream
// request per avatar instead of two, and recovers on rotation without a restart.
export function noteAvatarCredentialRefused(now: number = Date.now()): void {
  refusedUntil = now + REFUSAL_TTL_MS;
}

// Only deployment-wide credential failures suppress the shared token. Missing
// avatars, rate limits, and upstream outages are resource/request failures and
// must not disable unrelated avatar lookups. GitHub spends 403 on both "this
// token may not do that" and "this token has asked too often", so a throttled
// response is excluded explicitly — otherwise one burst of avatar traffic would
// switch every viewer back to their own token for a minute.
export function isAvatarCredentialRefusal(response: Response): boolean {
  if (isGitHubRateLimitResponse(response)) {
    return false;
  }
  return (
    response.status === 401 ||
    response.status === 403 ||
    (response.ok && !isImageResponse(response))
  );
}

export function resetAvatarCredentialRefusal(): void {
  refusedUntil = 0;
}
