// The API routes' one spelling of "this request's GitHub token": extracts the
// bearer credential and, when it is a sealed envelope (lib/tokenSeal),
// decrypts it under the deployment key. Bare tokens (pasted PATs, sessions
// from before DIFFSHUB_TOKEN_ENCRYPTION_KEY was configured) pass through
// untouched. An envelope that cannot be opened — key rotated or unset,
// tampered value, or a refresh envelope replayed as a bearer header —
// resolves to undefined, so the request proceeds as tokenless and the client
// recovers through its normal refresh / sign-in paths. This is deliberately
// looser than isTokenlessRequestBlocked (githubEnvironment), which stays
// presence-only: the login gate asks whether a credential was offered, not
// whether it decrypts.

import { getTokenEncryptionKey } from './githubEnvironment';
import { parseBearerToken } from './parseBearerToken';
import { isSealedToken, openSealedAccessToken } from './tokenSeal';

export async function resolveBearerToken(request: {
  headers: { get(name: string): string | null };
}): Promise<string | undefined> {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null || !isSealedToken(token)) {
    return token;
  }
  const key = getTokenEncryptionKey();
  return key == null ? undefined : openSealedAccessToken(token, key);
}
