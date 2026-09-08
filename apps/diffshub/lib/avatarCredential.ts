import { getAvatarLookupToken } from './githubEnvironment';

// Which credential pays for a GHES avatar lookup — the one upstream request a
// viewer signed in through a GitHub App cannot make with their own token (see
// GitHubWebAssetUpstream.isAvatarLookup), so a deployment may configure
// DIFFSHUB_AVATAR_TOKEN to pay for it.

const REFUSAL_TTL_MS = 60_000;

let refusedUntil = 0;

// Undefined means "use the viewer's own token".
//
// Only lent to a caller whose own credential resolved: the synchronous login
// gate accepts anything merely shaped like a sealed envelope without opening
// it, so without this a forged envelope could enumerate the instance's avatars.
export function resolveAvatarCredential(
  viewerToken: string | undefined,
  now: number = Date.now()
): string | undefined {
  if (viewerToken == null || now < refusedUntil) {
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

export function resetAvatarCredentialRefusal(): void {
  refusedUntil = 0;
}
