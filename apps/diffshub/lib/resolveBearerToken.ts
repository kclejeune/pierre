// The API routes' one spelling of "this request's GitHub token": extracts the
// bearer credential and, when it is a sealed envelope (lib/tokenSeal),
// decrypts it under the deployment key. When encryption is configured, bare
// credentials are rejected so sessions from before the policy was enabled
// must sign in again. An envelope that cannot be opened — key rotated or unset,
// tampered value, or a refresh envelope replayed as a bearer header —
// resolves to undefined, so the request proceeds as tokenless and the client
// recovers through its normal refresh / sign-in paths. The synchronous login
// gate rejects visibly bare credentials too; only this resolver can perform
// the asynchronous authenticity check for a sealed envelope.

import { getTokenEncryptionKey } from './githubEnvironment';
import { parseBearerToken } from './parseBearerToken';
import { isSealedToken } from './tokenEnvelope';
import { openSealedAccessToken } from './tokenSeal';

export async function resolveBearerToken(request: {
  headers: { get(name: string): string | null };
}): Promise<string | undefined> {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return token;
  }
  const key = getTokenEncryptionKey();
  if (!isSealedToken(token)) {
    return key == null ? token : undefined;
  }
  return key == null ? undefined : openSealedAccessToken(token, key);
}
