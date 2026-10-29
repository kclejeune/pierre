// AES-256-GCM sealing shared by lib/tokenSeal (browser-held credentials) and
// lib/githubReadCache (cached GitHub reads). Each caller owns its key
// handling, wire prefix, and additional data; this module owns the nonce and
// the `<nonce>.<ciphertext>` base64url encoding, so both formats encrypt the
// same way.

// 96-bit nonce, the standard GCM size.
const NONCE_BYTES = 12;

const textEncoder = new TextEncoder();

// Encrypts `plaintext` under a fresh random nonce, authenticating
// `additionalData` alongside it. Returns `<nonce>.<ciphertext>`, both
// base64url.
export async function sealGcm(
  key: CryptoKey,
  additionalData: Uint8Array<ArrayBuffer>,
  plaintext: string
): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(NONCE_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    { additionalData, iv: nonce, name: 'AES-GCM' },
    key,
    textEncoder.encode(plaintext)
  );
  return `${Buffer.from(nonce).toString('base64url')}.${Buffer.from(ciphertext).toString('base64url')}`;
}

// Decrypts what sealGcm produced. Returns undefined for anything that does
// not authenticate under this key and additional data: a malformed or
// tampered value, other additional data, or a rotated key.
export async function openGcm(
  key: CryptoKey,
  additionalData: Uint8Array<ArrayBuffer>,
  sealed: string
): Promise<string | undefined> {
  const parts = sealed.split('.');
  if (parts.length !== 2) {
    return undefined;
  }
  const [nonce = '', ciphertext = ''] = parts;
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        additionalData,
        iv: Buffer.from(nonce, 'base64url'),
        name: 'AES-GCM',
      },
      key,
      Buffer.from(ciphertext, 'base64url')
    );
    return Buffer.from(plaintext).toString('utf8');
  } catch {
    return undefined;
  }
}
