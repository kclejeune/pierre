// Server-enforced refresh-token lifetimes (DIFFSHUB_REFRESH_TOKEN_MAX_TTL).
//
// The browser treats a refresh token as an opaque string: it stores whatever
// `refresh_token` the server hands it and posts it back verbatim. That makes
// room to replace GitHub's token with a wrapped value carrying the epoch
// seconds when the viewer last completed a real GitHub authorization, MAC'd
// with the OAuth client secret. The refresh route unwraps and verifies before
// contacting GitHub, so a client cannot forge or extend its own session age —
// and because the original issue time is carried through every rotation, the
// cap bounds absolute session age rather than inactivity (GitHub's own
// six-month rotation window already provides the inactivity bound).
//
// Wire format: `dhr1.<payload>.<mac>` where payload is
// base64url(JSON {rt, iat}) and mac is base64url(HMAC-SHA256(`dhr1.<payload>`))
// keyed by the client secret — the prefix inside the MAC input doubles as a
// domain separator, so no other artifact MAC'd with the same secret can
// verify as a wrap. Rotating the client secret invalidates every outstanding
// wrapped token, which reads as a feature: it is the one credential the
// operator can revoke fleet-wide.
//
// When DIFFSHUB_TOKEN_ENCRYPTION_KEY is configured, new grants carry the
// dhe1 AES-GCM envelope (lib/tokenSeal) instead — it authenticates the same
// issue time via GCM's auth tag while also encrypting the token — and this
// wrap survives only to unwrap sessions issued before the key was set.

import { readNonEmptyString } from './githubOAuthGrant';
import { asRecord } from './untypedJson';

const WRAP_PREFIX = 'dhr1';

const textEncoder = new TextEncoder();

// Session ages are spelled in epoch seconds throughout — GitHub's own
// lifetime unit — so the one conversion from Date.now() lives here.
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

export interface UnwrappedRefreshToken {
  // Epoch seconds of the original OAuth authorization, preserved across
  // refresh-token rotations.
  issuedAt: number;
  refreshToken: string;
}

// Whether a stored refresh token is a wrap rather than a bare GitHub token.
// Callers key unwrapping off this shape, not off the current policy, so
// wrapped sessions keep working if the operator later removes the cap.
export function isWrappedRefreshToken(value: string): boolean {
  return value.startsWith(`${WRAP_PREFIX}.`);
}

async function importMACKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
}

export async function wrapRefreshToken(
  refreshToken: string,
  issuedAtSeconds: number,
  secret: string
): Promise<string> {
  const payload = Buffer.from(
    JSON.stringify({ rt: refreshToken, iat: issuedAtSeconds })
  ).toString('base64url');
  const signed = `${WRAP_PREFIX}.${payload}`;
  const mac = await crypto.subtle.sign(
    'HMAC',
    await importMACKey(secret),
    textEncoder.encode(signed)
  );
  return `${signed}.${Buffer.from(mac).toString('base64url')}`;
}

// Returns undefined for anything that is not a validly MAC'd wrap under this
// secret — a tampered value, a token wrapped under a rotated secret, or a
// bare GitHub token stored before the TTL was configured. Callers treat all
// of those the same way: the session cannot be trusted, sign in again.
export async function unwrapRefreshToken(
  wrapped: string,
  secret: string
): Promise<UnwrappedRefreshToken | undefined> {
  const parts = wrapped.split('.');
  if (parts.length !== 3 || parts[0] !== WRAP_PREFIX) {
    return undefined;
  }
  const [, payload = '', mac = ''] = parts;

  let valid: boolean;
  try {
    // crypto.subtle.verify compares in constant time, unlike a string
    // comparison of recomputed MACs.
    valid = await crypto.subtle.verify(
      'HMAC',
      await importMACKey(secret),
      Buffer.from(mac, 'base64url'),
      textEncoder.encode(`${WRAP_PREFIX}.${payload}`)
    );
  } catch {
    return undefined;
  }
  if (!valid) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  const record = asRecord(parsed);
  const refreshToken = readNonEmptyString(record?.rt);
  if (
    record == null ||
    refreshToken == null ||
    typeof record.iat !== 'number'
  ) {
    return undefined;
  }
  return { issuedAt: record.iat, refreshToken };
}
