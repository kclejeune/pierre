import { afterEach, describe, expect, test } from 'bun:test';

import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';
import {
  resolveBearerCredential,
  resolveBearerToken,
} from '../lib/resolveBearerToken';
import { isSealedToken } from '../lib/tokenEnvelope';
import {
  openSealedAccessToken,
  openSealedRefreshToken,
  sealAccessToken,
  sealRefreshToken,
} from '../lib/tokenSeal';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

describe('token sealing', () => {
  test('round-trips an access token', async () => {
    const sealed = await sealAccessToken('ghu_access', KEY);
    expect(sealed.startsWith('dhe1.access.')).toBe(true);
    expect(sealed).not.toContain('ghu_access');
    expect(isSealedToken(sealed)).toBe(true);
    expect(await openSealedAccessToken(sealed, KEY)).toBe('ghu_access');
  });

  test('round-trips a refresh token with its authorization time', async () => {
    const sealed = await sealRefreshToken('ghr_refresh', 1_700_000_000, KEY);
    expect(sealed.startsWith('dhe1.refresh.')).toBe(true);
    expect(await openSealedRefreshToken(sealed, KEY)).toEqual({
      issuedAt: 1_700_000_000,
      refreshToken: 'ghr_refresh',
    });
  });

  test('a fresh nonce makes every envelope distinct', async () => {
    expect(await sealAccessToken('ghu_access', KEY)).not.toBe(
      await sealAccessToken('ghu_access', KEY)
    );
  });

  test('rejects an envelope of the other kind', async () => {
    const access = await sealAccessToken('ghu_access', KEY);
    const refresh = await sealRefreshToken('ghr_refresh', 1_700_000_000, KEY);
    expect(await openSealedRefreshToken(access, KEY)).toBeUndefined();
    expect(await openSealedAccessToken(refresh, KEY)).toBeUndefined();
  });

  // The kind rides outside the ciphertext but is bound as GCM additional
  // data, so relabeling an envelope breaks its auth tag.
  test('rejects an envelope whose kind label was rewritten', async () => {
    const relabeled = (await sealRefreshToken('ghr_x', 1, KEY)).replace(
      '.refresh.',
      '.access.'
    );
    expect(await openSealedAccessToken(relabeled, KEY)).toBeUndefined();
  });

  test('rejects tampered ciphertext and garbage', async () => {
    const sealed = await sealAccessToken('ghu_access', KEY);
    const tampered =
      sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
    expect(await openSealedAccessToken(tampered, KEY)).toBeUndefined();
    expect(await openSealedAccessToken('ghu_bare', KEY)).toBeUndefined();
    expect(
      await openSealedAccessToken('dhe1.access.!!.!!', KEY)
    ).toBeUndefined();
  });

  test('rejects an envelope sealed under a different key', async () => {
    const sealed = await sealAccessToken('ghu_access', OTHER_KEY);
    expect(await openSealedAccessToken(sealed, KEY)).toBeUndefined();
  });
});

describe('resolveBearerToken', () => {
  afterEach(() => {
    delete process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY;
    resetGitHubEnvironmentCache();
  });

  function configureKey(key: Uint8Array): void {
    process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY =
      Buffer.from(key).toString('base64');
    resetGitHubEnvironmentCache();
  }

  // The minimal request shape the resolver reads: just the bearer header.
  function requestWithAuth(value?: string) {
    return {
      headers: new Headers(value == null ? {} : { authorization: value }),
    };
  }

  test('passes bare tokens through when encryption is disabled', async () => {
    expect(await resolveBearerToken(requestWithAuth('Bearer ghp_pat'))).toBe(
      'ghp_pat'
    );
    expect(await resolveBearerToken(requestWithAuth())).toBeUndefined();
    expect(
      await resolveBearerToken(requestWithAuth('nonsense'))
    ).toBeUndefined();
  });

  test('marks bare credentials unverified', async () => {
    expect(
      await resolveBearerCredential(requestWithAuth('Bearer ghp_pat'))
    ).toEqual({ token: 'ghp_pat', verified: false });
  });

  test('rejects bare tokens when encryption is required', async () => {
    configureKey(KEY);
    expect(
      await resolveBearerToken(requestWithAuth('Bearer ghu_legacy'))
    ).toBeUndefined();
    expect(
      await resolveBearerToken(requestWithAuth('Bearer ghp_manual'))
    ).toBeUndefined();
  });

  test('decrypts a sealed access token under the configured key', async () => {
    configureKey(KEY);
    const sealed = await sealAccessToken('ghu_access', KEY);
    expect(await resolveBearerToken(requestWithAuth(`Bearer ${sealed}`))).toBe(
      'ghu_access'
    );
    expect(
      await resolveBearerCredential(requestWithAuth(`Bearer ${sealed}`))
    ).toEqual({ token: 'ghu_access', verified: true });
  });

  test('resolves unopenable envelopes to tokenless', async () => {
    const sealed = await sealAccessToken('ghu_access', KEY);
    // No key configured: the envelope cannot be opened.
    expect(
      await resolveBearerToken(requestWithAuth(`Bearer ${sealed}`))
    ).toBeUndefined();
    // Key rotated since sealing.
    configureKey(OTHER_KEY);
    expect(
      await resolveBearerToken(requestWithAuth(`Bearer ${sealed}`))
    ).toBeUndefined();
  });

  test('refuses a refresh envelope replayed as a bearer credential', async () => {
    configureKey(KEY);
    const refresh = await sealRefreshToken('ghr_refresh', 1_700_000_000, KEY);
    expect(
      await resolveBearerToken(requestWithAuth(`Bearer ${refresh}`))
    ).toBeUndefined();
  });
});
