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

export interface ResolvedBearerCredential {
  // The GitHub token forwarded upstream.
  token: string;
  // True only when the deployment verified the credential's authenticated
  // envelope. Bare PATs are usable as viewer credentials but cannot authorize
  // access to a separate server-held credential.
  verified: boolean;
}

export async function resolveBearerCredential(request: {
  headers: { get(name: string): string | null };
}): Promise<ResolvedBearerCredential | undefined> {
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return undefined;
  }
  const key = getTokenEncryptionKey();
  if (!isSealedToken(token)) {
    return key == null ? { token, verified: false } : undefined;
  }
  if (key == null) {
    return undefined;
  }
  const opened = await openSealedAccessToken(token, key);
  return opened == null ? undefined : { token: opened, verified: true };
}

export async function resolveBearerToken(request: {
  headers: { get(name: string): string | null };
}): Promise<string | undefined> {
  return (await resolveBearerCredential(request))?.token;
}
