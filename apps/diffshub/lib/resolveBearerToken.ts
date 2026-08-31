// Request-side credential policy: one module owns both "what token does this
// request carry?" and "may it proceed without one?", so the two questions can
// never drift apart.
//
// resolveBearerToken extracts the bearer credential and, when it is a sealed
// envelope (lib/tokenSeal), decrypts it under the deployment key. Bare tokens
// (pasted PATs, sessions from before DIFFSHUB_TOKEN_ENCRYPTION_KEY was
// configured) pass through untouched unless the deployment requires sealed
// tokens. A credential that does not resolve — an envelope sealed under a
// rotated key, a tampered value, a refresh envelope replayed as a bearer
// header, or a bare token where only envelopes are accepted — resolves to
// undefined.
//
// The login gate below is defined in terms of that resolution, so on a
// require-login deployment a credential that does not resolve is refused the
// same way a missing one is: a 401 the client answers by re-authenticating.
// Elsewhere the request proceeds as tokenless and the client recovers through
// its normal refresh / sign-in paths.

import {
  getTokenEncryptionKey,
  isLoginRequired,
  isSealedTokenRequired,
  LOGIN_REQUIRED_MESSAGE,
} from './githubEnvironment';
import { createJSONResponse } from './jsonResponse';
import { parseBearerToken } from './parseBearerToken';
import { isSealedToken, openSealedAccessToken } from './tokenSeal';

interface BearerRequest {
  headers: { get(name: string): string | null };
}

const resolvedTokenByRequest = new WeakMap<
  BearerRequest,
  Promise<string | undefined>
>();

export function resolveBearerToken(
  request: BearerRequest
): Promise<string | undefined> {
  let pending = resolvedTokenByRequest.get(request);
  if (pending == null) {
    pending = resolveBearerTokenOnce(request);
    resolvedTokenByRequest.set(request, pending);
  }
  return pending;
}

async function resolveBearerTokenOnce(
  request: BearerRequest
): Promise<string | undefined> {
  // Validate both settings before inspecting the request. A broken deployment
  // must fail closed even when this particular request is anonymous.
  const key = getTokenEncryptionKey();
  const sealedTokenRequired = isSealedTokenRequired();
  const token = parseBearerToken(request.headers.get('authorization'));
  if (token == null) {
    return undefined;
  }
  if (!isSealedToken(token)) {
    // A sealed-tokens-only deployment accepts nothing it did not mint: the
    // envelope is the proof the credential came from this deployment's own
    // OAuth flow rather than a pasted PAT or a foreign token.
    return sealedTokenRequired ? undefined : token;
  }
  return key == null ? undefined : openSealedAccessToken(token, key);
}

// Server-side enforcement of DIFFSHUB_REQUIRE_LOGIN for API routes: true when
// the request must be refused on a require-login deployment. Every
// anonymously reachable read route checks this before doing upstream work, so
// the client-side login gate cannot be bypassed by requesting the APIs
// directly.
export async function isTokenlessRequestBlocked(
  request: BearerRequest
): Promise<boolean> {
  return isLoginRequired() && (await resolveBearerToken(request)) == null;
}

// The JSON form of the refusal: a 401 when the request must be blocked, null
// when it may proceed.
export async function rejectTokenlessRequestWhenLoginRequired(
  request: BearerRequest
): Promise<Response | null> {
  if (!(await isTokenlessRequestBlocked(request))) {
    return null;
  }
  return createJSONResponse({ error: LOGIN_REQUIRED_MESSAGE }, { status: 401 });
}
