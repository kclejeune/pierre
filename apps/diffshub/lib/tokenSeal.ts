// Opt-in at-rest encryption for the credentials the browser stores
// (DIFFSHUB_TOKEN_ENCRYPTION_KEY; see githubEnvironment). The browser treats
// tokens as opaque strings, so when the key is configured the server seals a
// grant's access and refresh tokens into AES-256-GCM envelopes before they
// ever reach the client: the OAuth completion fragment, localStorage, and the
// refresh POST body all carry ciphertext, and the bare GitHub credential
// exists only inside the API routes, which decrypt on arrival (see
// resolveBearerToken). The server stays stateless — it holds a key, not
// sessions.
//
// Wire format: `dhe1.<kind>.<nonce>.<ciphertext>` where kind is 'access' or
// 'refresh' and nonce/ciphertext are base64url. `dhe1.<kind>` is bound as GCM
// additional data, so an envelope of one kind cannot be replayed as the
// other. The plaintext is JSON {t, iat?}; refresh envelopes carry the epoch
// seconds of the original GitHub authorization for max-TTL enforcement, which
// makes them supersede the dhr1 HMAC wrap (lib/refreshTokenWrap) — GCM's auth
// tag already provides the integrity the HMAC did. Rotating the key
// invalidates every outstanding sealed credential fleet-wide.
//
// Pure mechanism: every function takes the key explicitly. Configuration
// lives in githubEnvironment, and the request-side policy of extracting and
// decrypting a bearer header lives in resolveBearerToken.

import { readNonEmptyString } from './githubOAuthGrant';
import { type UnwrappedRefreshToken } from './refreshTokenWrap';
import { asRecord } from './untypedJson';

const SEAL_PREFIX = 'dhe1';
// 96-bit nonce, the standard GCM size.
const NONCE_BYTES = 12;

type SealedTokenKind = 'access' | 'refresh';

const textEncoder = new TextEncoder();

// The `dhe1.<kind>` prefix doubles as the additional-data domain separator:
// it authenticates the envelope's declared kind without encrypting it.
const SEAL_AAD: Record<SealedTokenKind, Uint8Array<ArrayBuffer>> = {
  access: textEncoder.encode(`${SEAL_PREFIX}.access`),
  refresh: textEncoder.encode(`${SEAL_PREFIX}.refresh`),
};

// Whether a stored credential is a sealed envelope rather than a bare GitHub
// token. Callers key decryption off this shape, not off the current config,
// so bare tokens (pasted PATs, sessions from before the key was configured)
// keep working unchanged.
export function isSealedToken(value: string): boolean {
  return value.startsWith(`${SEAL_PREFIX}.`);
}

// One CryptoKey per raw key: getTokenEncryptionKey memoizes and hands back
// the same array instance for the process lifetime, so identity-keying makes
// a rotation (a fresh parse yields a fresh array) invalidate this cache for
// free, and the decrypt-per-request hot path skips the re-import.
const importedKeys = new WeakMap<Uint8Array, Promise<CryptoKey>>();

function importSealKey(key: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
  let imported = importedKeys.get(key);
  if (imported == null) {
    imported = crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, [
      'encrypt',
      'decrypt',
    ]);
    importedKeys.set(key, imported);
  }
  return imported;
}

async function seal(
  kind: SealedTokenKind,
  payload: Record<string, unknown>,
  key: Uint8Array<ArrayBuffer>
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, additionalData: SEAL_AAD[kind] },
    await importSealKey(key),
    textEncoder.encode(JSON.stringify(payload))
  );
  const encodedNonce = Buffer.from(nonce).toString('base64url');
  const encodedCiphertext = Buffer.from(ciphertext).toString('base64url');
  return `${SEAL_PREFIX}.${kind}.${encodedNonce}.${encodedCiphertext}`;
}

// Returns undefined for anything that is not a valid envelope of this kind
// under this key — a tampered value, a different kind, or a credential sealed
// under a rotated key. Callers treat all of those as an unusable credential.
async function open(
  kind: SealedTokenKind,
  sealed: string,
  key: Uint8Array<ArrayBuffer>
): Promise<Record<string, unknown> | undefined> {
  const parts = sealed.split('.');
  if (parts.length !== 4 || parts[0] !== SEAL_PREFIX || parts[1] !== kind) {
    return undefined;
  }
  const [, , nonce = '', ciphertext = ''] = parts;

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv: Buffer.from(nonce, 'base64url'),
        additionalData: SEAL_AAD[kind],
      },
      await importSealKey(key),
      Buffer.from(ciphertext, 'base64url')
    );
  } catch {
    return undefined;
  }

  try {
    return (
      asRecord(JSON.parse(Buffer.from(plaintext).toString('utf8'))) ?? undefined
    );
  } catch {
    return undefined;
  }
}

export async function sealAccessToken(
  token: string,
  key: Uint8Array<ArrayBuffer>
): Promise<string> {
  return seal('access', { t: token }, key);
}

export async function openSealedAccessToken(
  sealed: string,
  key: Uint8Array<ArrayBuffer>
): Promise<string | undefined> {
  return readNonEmptyString((await open('access', sealed, key))?.t);
}

export async function sealRefreshToken(
  token: string,
  issuedAtSeconds: number,
  key: Uint8Array<ArrayBuffer>
): Promise<string> {
  return seal('refresh', { t: token, iat: issuedAtSeconds }, key);
}

// Same shape the dhr1 wrap unwraps to, so refreshOAuthToken handles both
// formats through one pair of variables.
export async function openSealedRefreshToken(
  sealed: string,
  key: Uint8Array<ArrayBuffer>
): Promise<UnwrappedRefreshToken | undefined> {
  const record = await open('refresh', sealed, key);
  const refreshToken = readNonEmptyString(record?.t);
  if (refreshToken == null || typeof record?.iat !== 'number') {
    return undefined;
  }
  return { issuedAt: record.iat, refreshToken };
}
