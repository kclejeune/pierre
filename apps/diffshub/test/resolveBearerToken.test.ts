import { beforeEach, describe, expect, test } from 'bun:test';

import {
  isLoginRequired,
  resetGitHubEnvironmentCache,
} from '../lib/githubEnvironment';
import {
  rejectTokenlessRequestWhenLoginRequired,
  resolveBearerToken,
} from '../lib/resolveBearerToken';
import { sealAccessToken, sealRefreshToken } from '../lib/tokenSeal';
import { useIsolatedEnvironment } from './helpers/env';

const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

useIsolatedEnvironment([
  'DIFFSHUB_GITHUB_CLIENT_ID',
  'DIFFSHUB_GITHUB_CLIENT_SECRET',
  'DIFFSHUB_REQUIRE_LOGIN',
  'DIFFSHUB_GITHUB_URL',
  'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
  'DIFFSHUB_REQUIRE_SEALED_TOKENS',
]);

beforeEach(() => {
  process.env.DIFFSHUB_GITHUB_CLIENT_ID = 'id';
  process.env.DIFFSHUB_GITHUB_CLIENT_SECRET = 'secret';
});

function configureKey(key: Uint8Array): void {
  process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY =
    Buffer.from(key).toString('base64');
  resetGitHubEnvironmentCache();
}

// Request stub carrying only the headers surface the token policy reads.
function createRequest(authorization?: string): {
  headers: { get(name: string): string | null };
} {
  return {
    headers: {
      get: (name: string) =>
        name.toLowerCase() === 'authorization' ? (authorization ?? null) : null,
    },
  };
}

describe('resolveBearerToken', () => {
  test('passes bare tokens through untouched', async () => {
    expect(await resolveBearerToken(createRequest('Bearer ghp_pat'))).toBe(
      'ghp_pat'
    );
    expect(await resolveBearerToken(createRequest())).toBeUndefined();
    expect(await resolveBearerToken(createRequest('nonsense'))).toBeUndefined();
  });

  test('memoizes resolution for the lifetime of a request', () => {
    const request = createRequest('Bearer ghp_pat');
    expect(resolveBearerToken(request)).toBe(resolveBearerToken(request));
  });

  test('decrypts a sealed access token under the configured key', async () => {
    configureKey(KEY);
    const sealed = await sealAccessToken('ghu_access', KEY);
    expect(await resolveBearerToken(createRequest(`Bearer ${sealed}`))).toBe(
      'ghu_access'
    );
  });

  test('resolves unopenable envelopes to tokenless', async () => {
    const sealed = await sealAccessToken('ghu_access', KEY);
    // No key configured: the envelope cannot be opened.
    expect(
      await resolveBearerToken(createRequest(`Bearer ${sealed}`))
    ).toBeUndefined();
    // Key rotated since sealing.
    configureKey(OTHER_KEY);
    expect(
      await resolveBearerToken(createRequest(`Bearer ${sealed}`))
    ).toBeUndefined();
  });

  test('refuses a refresh envelope replayed as a bearer credential', async () => {
    configureKey(KEY);
    const refresh = await sealRefreshToken('ghr_refresh', 1_700_000_000, KEY);
    expect(
      await resolveBearerToken(createRequest(`Bearer ${refresh}`))
    ).toBeUndefined();
  });
});

// DIFFSHUB_REQUIRE_SEALED_TOKENS: the server-enforced counterpart of hiding
// the PAT box — only credentials this deployment's own OAuth flow sealed are
// accepted.
describe('sealed-tokens-only mode', () => {
  test('rejects bare tokens and accepts envelopes', async () => {
    configureKey(KEY);
    process.env.DIFFSHUB_REQUIRE_SEALED_TOKENS = '1';
    expect(
      await resolveBearerToken(createRequest('Bearer ghp_pasted_pat'))
    ).toBeUndefined();
    const sealed = await sealAccessToken('ghu_access', KEY);
    expect(await resolveBearerToken(createRequest(`Bearer ${sealed}`))).toBe(
      'ghu_access'
    );
  });

  test('is a configuration error without an encryption key, even anonymously', async () => {
    process.env.DIFFSHUB_REQUIRE_SEALED_TOKENS = '1';
    const thrown = await resolveBearerToken(createRequest()).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain(
      'DIFFSHUB_TOKEN_ENCRYPTION_KEY'
    );
  });

  test('rejects malformed base64 keys instead of decoding them permissively', async () => {
    process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY = `${Buffer.from(KEY).toString(
      'base64'
    )}!`;
    resetGitHubEnvironmentCache();
    const thrown = await resolveBearerToken(createRequest()).then(
      () => undefined,
      (error: unknown) => error
    );
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('32 base64-encoded bytes');
  });
});

describe('require-login policy', () => {
  test('github.com deployments leave the gate open by default', async () => {
    expect(isLoginRequired()).toBe(false);
    expect(
      await rejectTokenlessRequestWhenLoginRequired(createRequest())
    ).toBeNull();
  });

  test('require-login rejects tokenless requests', async () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    const rejection =
      await rejectTokenlessRequestWhenLoginRequired(createRequest());
    expect(rejection?.status).toBe(401);
  });

  test('require-login passes requests carrying their own bearer token', async () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = 'true';
    const request = createRequest('Bearer user-token');
    expect(await rejectTokenlessRequestWhenLoginRequired(request)).toBeNull();
  });

  test('falsy DIFFSHUB_REQUIRE_LOGIN leaves the gate open', async () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '0';
    expect(
      await rejectTokenlessRequestWhenLoginRequired(createRequest())
    ).toBeNull();
  });

  // A self-hosted instance is private by definition: there is nothing an
  // anonymous caller could read, so the gate defaults on and turns the wall
  // of upstream 401s into a sign-in prompt.
  test('self-hosted deployments require login by default', async () => {
    process.env.DIFFSHUB_GITHUB_URL = 'https://ghe.corp.dev';
    expect(isLoginRequired()).toBe(true);
    expect(
      (await rejectTokenlessRequestWhenLoginRequired(createRequest()))?.status
    ).toBe(401);
    expect(
      await rejectTokenlessRequestWhenLoginRequired(
        createRequest('Bearer user-token')
      )
    ).toBeNull();
  });

  test('an explicit DIFFSHUB_REQUIRE_LOGIN=0 opens a self-hosted gate', async () => {
    process.env.DIFFSHUB_GITHUB_URL = 'https://ghe.corp.dev';
    process.env.DIFFSHUB_REQUIRE_LOGIN = 'false';
    expect(isLoginRequired()).toBe(false);
    expect(
      await rejectTokenlessRequestWhenLoginRequired(createRequest())
    ).toBeNull();
  });

  // The gate is defined over *resolution*, not header presence: a credential
  // the server cannot read is refused the same way a missing one is, so a
  // key rotation walls every stale session off at the API instead of letting
  // it degrade to anonymous access.
  test('require-login rejects an unopenable envelope', async () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    configureKey(KEY);
    const foreign = await sealAccessToken('ghu_access', OTHER_KEY);
    expect(
      (
        await rejectTokenlessRequestWhenLoginRequired(
          createRequest(`Bearer ${foreign}`)
        )
      )?.status
    ).toBe(401);
    expect(
      (
        await rejectTokenlessRequestWhenLoginRequired(
          createRequest('Bearer dhe1.garbage')
        )
      )?.status
    ).toBe(401);
  });
});
