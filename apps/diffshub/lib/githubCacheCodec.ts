// Key hashing and value sealing for entries in the GitHub cache store
// (lib/githubCacheStore), shared by the read cache (lib/githubReadCache) and
// the org repository listings (lib/githubOrgRepos).
//
// Keys are a hash of the logical key, so repository names never appear in
// the store. With DIFFSHUB_TOKEN_ENCRYPTION_KEY set, the hash is an HMAC and
// values are AES-256-GCM sealed under subkeys derived from the instance key
// (HKDF), with the store key bound as additional data; rotating the instance
// key makes every old entry unreadable, and they age out by TTL.

import { openGcm, sealGcm } from './aesGcm';
import {
  CACHE_KEY_PREFIX,
  type CacheStore,
  type GitHubCacheLimits,
} from './githubCacheStore';

const textEncoder = new TextEncoder();
const PLAIN_PREFIX = 'p1.';
const SEALED_PREFIX = 'e1.';

interface CacheKeys {
  encrypt: CryptoKey;
  mac: CryptoKey;
}

// Subkeys per instance key, derived once. Keyed by array identity like
// tokenSeal's import cache: getTokenEncryptionKey memoizes one array per
// process, and a rotated key is a fresh array.
const derivedKeys = new WeakMap<Uint8Array, Promise<CacheKeys>>();

function deriveCacheKeys(key: Uint8Array<ArrayBuffer>): Promise<CacheKeys> {
  let derived = derivedKeys.get(key);
  if (derived == null) {
    derived = (async () => {
      const base = await crypto.subtle.importKey('raw', key, 'HKDF', false, [
        'deriveKey',
      ]);
      const hkdf = (info: string) => ({
        hash: 'SHA-256',
        info: textEncoder.encode(info),
        name: 'HKDF',
        salt: new Uint8Array(),
      });
      const [encrypt, mac] = await Promise.all([
        crypto.subtle.deriveKey(
          hkdf('diffshub github cache v1 encrypt'),
          base,
          { length: 256, name: 'AES-GCM' },
          false,
          ['encrypt', 'decrypt']
        ),
        crypto.subtle.deriveKey(
          hkdf('diffshub github cache v1 key'),
          base,
          { hash: 'SHA-256', length: 256, name: 'HMAC' },
          false,
          ['sign']
        ),
      ]);
      return { encrypt, mac };
    })();
    derivedKeys.set(key, derived);
  }
  return derived;
}

async function storeCacheKey(
  logical: string,
  encryptionKey: Uint8Array<ArrayBuffer> | undefined
): Promise<string> {
  const data = textEncoder.encode(logical);
  const digest =
    encryptionKey == null
      ? await crypto.subtle.digest('SHA-256', data)
      : await crypto.subtle.sign(
          'HMAC',
          (await deriveCacheKeys(encryptionKey)).mac,
          data
        );
  return `${CACHE_KEY_PREFIX}${Buffer.from(digest).toString('base64url')}`;
}

async function sealCacheValue(
  json: string,
  key: string,
  encryptionKey: Uint8Array<ArrayBuffer> | undefined
): Promise<string> {
  if (encryptionKey == null) {
    return `${PLAIN_PREFIX}${json}`;
  }
  return `${SEALED_PREFIX}${await sealGcm(
    (await deriveCacheKeys(encryptionKey)).encrypt,
    textEncoder.encode(key),
    json
  )}`;
}

// Returns undefined (a miss) for anything this instance did not write under
// its current configuration: a value from before encryption was enabled, one
// sealed under a rotated key, or a tampered value.
async function openCacheValue(
  raw: string,
  key: string,
  encryptionKey: Uint8Array<ArrayBuffer> | undefined
): Promise<unknown> {
  if (encryptionKey == null) {
    return raw.startsWith(PLAIN_PREFIX)
      ? (JSON.parse(raw.slice(PLAIN_PREFIX.length)) as unknown)
      : undefined;
  }
  if (!raw.startsWith(SEALED_PREFIX)) {
    return undefined;
  }
  const plaintext = await openGcm(
    (await deriveCacheKeys(encryptionKey)).encrypt,
    textEncoder.encode(key),
    raw.slice(SEALED_PREFIX.length)
  );
  return plaintext == null ? undefined : (JSON.parse(plaintext) as unknown);
}

// What a cache read or write needs: the store, its limits, and the instance
// key (undefined stores plain, hashed-key entries).
export interface CacheContext {
  encryptionKey: Uint8Array<ArrayBuffer> | undefined;
  limits: GitHubCacheLimits;
  store: CacheStore;
}

// One logical entry in the store. The store key (an HMAC of `logical`) is
// derived once, so a read that misses and the write that follows share it.
//
// read: the stored value, or undefined on a miss (including values this
// instance can't open). write: stores `value` as JSON, skipping values over
// the entry cap (checked before sealing, which only grows them, and after);
// `ttlSeconds` overrides the configured TTL. Store failures throw from both,
// for the caller to log and treat as a miss.
export function cacheEntry(
  context: CacheContext,
  logical: string
): {
  read: () => Promise<unknown>;
  write: (value: unknown, ttlSeconds?: number) => Promise<void>;
} {
  const { encryptionKey, limits, store } = context;
  let key: Promise<string> | undefined;
  const storeKey = () => (key ??= storeCacheKey(logical, encryptionKey));
  return {
    async read() {
      const resolved = await storeKey();
      const raw = await store.get(resolved);
      return raw == null
        ? undefined
        : openCacheValue(raw, resolved, encryptionKey);
    },
    async write(value, ttlSeconds) {
      const json = JSON.stringify(value);
      if (Buffer.byteLength(json) > limits.maxEntryBytes) {
        return;
      }
      const resolved = await storeKey();
      const sealed = await sealCacheValue(json, resolved, encryptionKey);
      if (Buffer.byteLength(sealed) <= limits.maxEntryBytes) {
        await store.put(
          resolved,
          sealed,
          ttlSeconds == null ? limits : { ...limits, ttlSeconds }
        );
      }
    },
  };
}
