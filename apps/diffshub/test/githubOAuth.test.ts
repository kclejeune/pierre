import { beforeEach, describe, expect, test } from 'bun:test';

import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';
import {
  buildAuthorizeURL,
  buildCompletionURL,
  clampRefreshTokenGrant,
  exchangeOAuthCode,
  getPublicOrigin,
  OAuthRefreshRejectedError,
  parseOAuthState,
  refreshOAuthToken,
  sanitizeReturnTo,
  serializeOAuthState,
} from '../lib/githubOAuth';
import { parseGrantFragment } from '../lib/githubOAuthGrant';
import {
  nowSeconds,
  unwrapRefreshToken,
  wrapRefreshToken,
} from '../lib/refreshTokenWrap';
import {
  openSealedAccessToken,
  openSealedRefreshToken,
  sealRefreshToken,
} from '../lib/tokenSeal';
import { useIsolatedEnvironment } from './helpers/env';

describe('sanitizeReturnTo', () => {
  test('keeps same-origin paths', () => {
    expect(sanitizeReturnTo('/owner/repo/pull/1')).toBe('/owner/repo/pull/1');
    expect(sanitizeReturnTo('/owner/repo/pull/1?domain=x#L1')).toBe(
      '/owner/repo/pull/1?domain=x#L1'
    );
  });

  test('rejects open-redirect shapes', () => {
    expect(sanitizeReturnTo('https://evil.example')).toBe('/');
    expect(sanitizeReturnTo('//evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\\evil.example')).toBe('/');
    expect(sanitizeReturnTo('')).toBe('/');
    expect(sanitizeReturnTo(null)).toBe('/');
  });

  // The URL parser strips every ASCII tab, LF, and CR before parsing, so each
  // of these loads as https://evil.example despite starting with one slash.
  test('rejects targets whitespace turns protocol-relative', () => {
    expect(sanitizeReturnTo('/\n/evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\r/evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\t/evil.example')).toBe('/');
    expect(sanitizeReturnTo('/\n\\evil.example')).toBe('/');
    expect(sanitizeReturnTo('java\nscript:alert(1)')).toBe('/');
  });

  test('normalizes a surviving path to its resolved form', () => {
    expect(sanitizeReturnTo('/owner/repo/../pull/1')).toBe('/owner/pull/1');
    expect(sanitizeReturnTo('/')).toBe('/');
  });
});

describe('OAuth state round trip', () => {
  test('serializes and parses state with a return path', () => {
    const serialized = serializeOAuthState({
      returnTo: '/owner/repo/pull/1?x=1',
      state: 'abc-123',
    });
    expect(parseOAuthState(serialized)).toEqual({
      returnTo: '/owner/repo/pull/1?x=1',
      state: 'abc-123',
    });
  });

  test('sanitizes a tampered return path on parse', () => {
    expect(
      parseOAuthState(
        JSON.stringify({ returnTo: '//evil.example', state: 'abc' })
      )
    ).toEqual({
      returnTo: '/',
      state: 'abc',
    });
  });

  test('rejects malformed cookies', () => {
    expect(parseOAuthState(undefined)).toBeUndefined();
    expect(parseOAuthState('')).toBeUndefined();
    expect(parseOAuthState('not json')).toBeUndefined();
    expect(parseOAuthState('{"state":"abc"}')).toBeUndefined();
  });
});

describe('getPublicOrigin', () => {
  const BIND_ORIGIN = 'http://0.0.0.0:3000';

  test('DIFFSHUB_PUBLIC_ORIGIN wins over headers', () => {
    process.env.DIFFSHUB_PUBLIC_ORIGIN = 'https://diffs.corp.dev/';
    try {
      expect(
        getPublicOrigin(
          new Headers({ host: 'other.example', 'x-forwarded-proto': 'http' }),
          BIND_ORIGIN
        )
      ).toBe('https://diffs.corp.dev');
    } finally {
      delete process.env.DIFFSHUB_PUBLIC_ORIGIN;
    }
  });

  test('derives origin from proxy-forwarded headers', () => {
    expect(
      getPublicOrigin(
        new Headers({
          host: 'diffs.corp.dev',
          'x-forwarded-host': 'diffs.corp.dev',
          'x-forwarded-proto': 'https',
        }),
        BIND_ORIGIN
      )
    ).toBe('https://diffs.corp.dev');
  });

  test('uses the first forwarded protocol when proxies chain', () => {
    expect(
      getPublicOrigin(
        new Headers({
          host: 'diffs.corp.dev',
          'x-forwarded-proto': 'https, http',
        }),
        BIND_ORIGIN
      )
    ).toBe('https://diffs.corp.dev');
  });

  test('keeps the request protocol for direct host access', () => {
    expect(
      getPublicOrigin(new Headers({ host: 'localhost:3692' }), BIND_ORIGIN)
    ).toBe('http://localhost:3692');
  });

  test('falls back to the request origin without a host header', () => {
    expect(getPublicOrigin(new Headers(), BIND_ORIGIN)).toBe(BIND_ORIGIN);
  });
});

describe('buildAuthorizeURL', () => {
  test('targets the configured GitHub instance', () => {
    const url = new URL(
      buildAuthorizeURL({
        clientId: 'client123',
        redirectURI: 'https://diffs.corp.dev/api/auth/github/callback',
        state: 'state456',
        webURL: 'https://github.example.com',
      })
    );
    expect(url.origin).toBe('https://github.example.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('client123');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://diffs.corp.dev/api/auth/github/callback'
    );
    expect(url.searchParams.get('scope')).toBe('repo');
    expect(url.searchParams.get('state')).toBe('state456');
  });
});

describe('buildCompletionURL', () => {
  test('carries the token only in the fragment', () => {
    const url = buildCompletionURL({
      grant: { accessToken: 'gho_secret' },
      returnTo: '/owner/repo/pull/1',
    });
    expect(url).toBe(
      '/auth/github?returnTo=%2Fowner%2Frepo%2Fpull%2F1#access_token=gho_secret'
    );
    expect(url.split('#')[0]).not.toContain('gho_secret');
  });

  test('omits the default return path and carries errors as query', () => {
    expect(buildCompletionURL({ error: 'nope', returnTo: '/' })).toBe(
      '/auth/github?error=nope'
    );
  });

  // An expiring GitHub App grant round-trips through the fragment intact;
  // a bare token (OAuth App, non-expiring app) parses back without lifetimes.
  test('round-trips an expiring grant through the fragment', () => {
    const grant = {
      accessToken: 'ghu_access',
      expiresIn: 28800,
      refreshToken: 'ghr_refresh',
      refreshTokenExpiresIn: 15811200,
    };
    const url = buildCompletionURL({ grant });
    expect(url.split('#')[0]).toBe('/auth/github');
    expect(parseGrantFragment(url.slice(url.indexOf('#')))).toEqual(grant);

    expect(parseGrantFragment('#access_token=gho_plain')).toEqual({
      accessToken: 'gho_plain',
      expiresIn: undefined,
      refreshToken: undefined,
      refreshTokenExpiresIn: undefined,
    });
    expect(parseGrantFragment('#refresh_token=ghr_only')).toBeUndefined();
    expect(parseGrantFragment('')).toBeUndefined();
  });
});

describe('exchangeOAuthCode', () => {
  const baseOptions = {
    clientId: 'id',
    clientSecret: 'secret',
    code: 'code123',
    redirectURI: 'https://diffs.corp.dev/api/auth/github/callback',
    webURL: 'https://github.example.com',
  };

  test('posts to the instance token endpoint and returns the token', async () => {
    let requestedURL: string | undefined;
    let requestedBody: unknown;
    const grant = await exchangeOAuthCode({
      ...baseOptions,
      fetcher: (input: RequestInfo | URL, init?: RequestInit) => {
        requestedURL = String(input);
        requestedBody = JSON.parse(init?.body as string);
        return Promise.resolve(Response.json({ access_token: 'gho_token' }));
      },
    });
    expect(grant).toEqual({
      accessToken: 'gho_token',
      expiresIn: undefined,
      refreshToken: undefined,
      refreshTokenExpiresIn: undefined,
    });
    expect(requestedURL).toBe(
      'https://github.example.com/login/oauth/access_token'
    );
    expect(requestedBody).toEqual({
      client_id: 'id',
      client_secret: 'secret',
      code: 'code123',
      redirect_uri: 'https://diffs.corp.dev/api/auth/github/callback',
    });
  });

  test('surfaces GitHub error descriptions from 200 responses', async () => {
    const error = await exchangeOAuthCode({
      ...baseOptions,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            error: 'bad_verification_code',
            error_description: 'The code passed is incorrect or expired.',
          })
        ),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(
      'The code passed is incorrect or expired.'
    );
  });

  test('surfaces HTTP failures', async () => {
    const error = await exchangeOAuthCode({
      ...baseOptions,
      fetcher: () =>
        Promise.resolve(
          new Response('nope', { status: 502, statusText: 'Bad Gateway' })
        ),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('502');
  });

  // GitHub Apps with token expiration answer with lifetimes and a refresh
  // token alongside the access token (numbers, though the fragment parser
  // also accepts strings).
  test('keeps the refresh token and lifetimes of an expiring grant', async () => {
    const grant = await exchangeOAuthCode({
      ...baseOptions,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            access_token: 'ghu_token',
            expires_in: 28800,
            refresh_token: 'ghr_token',
            refresh_token_expires_in: 15811200,
            token_type: 'bearer',
            scope: '',
          })
        ),
    });
    expect(grant).toEqual({
      accessToken: 'ghu_token',
      expiresIn: 28800,
      refreshToken: 'ghr_token',
      refreshTokenExpiresIn: 15811200,
    });
  });
});

describe('refreshOAuthToken', () => {
  const baseOptions = {
    clientId: 'id',
    clientSecret: 'secret',
    refreshToken: 'ghr_old',
    webURL: 'https://github.example.com',
  };

  test('posts a refresh_token grant and returns the rotated grant', async () => {
    let requestedBody: unknown;
    const grant = await refreshOAuthToken({
      ...baseOptions,
      fetcher: (_input: RequestInfo | URL, init?: RequestInit) => {
        requestedBody = JSON.parse(init?.body as string);
        return Promise.resolve(
          Response.json({
            access_token: 'ghu_new',
            expires_in: 28800,
            refresh_token: 'ghr_new',
            refresh_token_expires_in: 15811200,
          })
        );
      },
    });
    expect(requestedBody).toEqual({
      client_id: 'id',
      client_secret: 'secret',
      grant_type: 'refresh_token',
      refresh_token: 'ghr_old',
    });
    expect(grant.accessToken).toBe('ghu_new');
    expect(grant.refreshToken).toBe('ghr_new');
  });

  // Unwrapping keys off the token's own wrapped shape, not the current
  // config, so sessions wrapped under a since-removed cap keep refreshing.
  test('a wrapped token still refreshes after the cap is removed', async () => {
    let requestedToken: unknown;
    const grant = await refreshOAuthToken({
      ...baseOptions,
      refreshToken: await wrapRefreshToken(
        'ghr_old',
        nowSeconds() - 1000,
        'secret'
      ),
      fetcher: (_input: RequestInfo | URL, init?: RequestInit) => {
        requestedToken = (
          JSON.parse(init?.body as string) as Record<string, unknown>
        ).refresh_token;
        return Promise.resolve(
          Response.json({ access_token: 'ghu_new', refresh_token: 'ghr_new' })
        );
      },
    });
    expect(requestedToken).toBe('ghr_old');
    expect(grant.refreshToken).toBe('ghr_new');
  });

  // bad_refresh_token is the one failure the session cannot recover from;
  // it gets its own error class so the route can answer 401 instead of 502.
  test('distinguishes a rejected refresh token from other failures', async () => {
    const rejected = await refreshOAuthToken({
      ...baseOptions,
      fetcher: () =>
        Promise.resolve(
          Response.json({
            error: 'bad_refresh_token',
            error_description:
              'The refresh token passed is incorrect or expired.',
          })
        ),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);

    const transient = await refreshOAuthToken({
      ...baseOptions,
      fetcher: () => Promise.resolve(new Response('nope', { status: 503 })),
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(transient).toBeInstanceOf(Error);
    expect(transient).not.toBeInstanceOf(OAuthRefreshRejectedError);
  });

  // With refresh tokens disabled, any submitted token predates the policy;
  // the unrecoverable-rejection error makes the route answer 401 so the
  // browser clears it and prompts a fresh sign-in — without contacting GitHub.
  test('rejects before contacting GitHub when the deployment disables refresh tokens', async () => {
    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '0';
    resetGitHubEnvironmentCache();
    try {
      const rejected = await refreshOAuthToken({
        ...baseOptions,
        fetcher: () => {
          throw new Error('GitHub must not be contacted');
        },
      }).then(
        () => undefined,
        (thrown: unknown) => thrown
      );
      expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);
    } finally {
      delete process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL;
      resetGitHubEnvironmentCache();
    }
  });
});

describe('clampRefreshTokenGrant', () => {
  const EXPIRING_GRANT = {
    accessToken: 'ghu_token',
    expiresIn: 28_800,
    refreshToken: 'ghr_refresh',
    refreshTokenExpiresIn: 15_811_200,
  };

  test('no remaining allowance (no cap) passes grants through untouched', () => {
    expect(clampRefreshTokenGrant(EXPIRING_GRANT, undefined)).toEqual(
      EXPIRING_GRANT
    );
  });

  test('an exhausted allowance strips the refresh token but keeps the expiry', () => {
    expect(clampRefreshTokenGrant(EXPIRING_GRANT, 0)).toEqual({
      accessToken: 'ghu_token',
      expiresIn: 28_800,
    });
  });

  test('a positive allowance clamps only lifetimes above it', () => {
    const capped = clampRefreshTokenGrant(EXPIRING_GRANT, 86_400);
    expect(capped.refreshTokenExpiresIn).toBe(86_400);
    expect(capped.refreshToken).toBe('ghr_refresh');

    expect(
      clampRefreshTokenGrant(EXPIRING_GRANT, 30_000_000).refreshTokenExpiresIn
    ).toBe(15_811_200);
  });

  test('a refresh token GitHub issued without a lifetime still gets the cap', () => {
    expect(
      clampRefreshTokenGrant(
        { accessToken: 'ghu_token', refreshToken: 'ghr_refresh' },
        3600
      ).refreshTokenExpiresIn
    ).toBe(3600);
  });

  test('grants without a refresh token are untouched by the cap', () => {
    expect(clampRefreshTokenGrant({ accessToken: 'ghp_pat' }, 3600)).toEqual({
      accessToken: 'ghp_pat',
    });
  });
});

// Server-enforced absolute session age: with a positive max TTL every grant's
// refresh token leaves the server wrapped with the original authorization
// time, and the refresh route verifies it before contacting GitHub.
describe('refresh-token wrapping under a max TTL', () => {
  const DAY = 24 * 3600;
  const GRANT_RESPONSE = {
    access_token: 'ghu_new',
    expires_in: 28_800,
    refresh_token: 'ghr_new',
    refresh_token_expires_in: 15_811_200,
  };

  useIsolatedEnvironment(['DIFFSHUB_REFRESH_TOKEN_MAX_TTL']);

  beforeEach(() => {
    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '7d';
    resetGitHubEnvironmentCache();
  });

  test('a first sign-in wraps the refresh token, anchored to now', async () => {
    const now = nowSeconds();
    const grant = await exchangeOAuthCode({
      clientId: 'id',
      clientSecret: 'secret',
      code: 'code',
      redirectURI: 'https://diffs.example.com/api/auth/github/callback',
      webURL: 'https://github.example.com',
      fetcher: () => Promise.resolve(Response.json(GRANT_RESPONSE)),
    });
    const unwrapped = await unwrapRefreshToken(
      grant.refreshToken ?? '',
      'secret'
    );
    expect(unwrapped?.refreshToken).toBe('ghr_new');
    expect(unwrapped?.issuedAt).toBeWithin(now, now + 31);
    expect(grant.refreshTokenExpiresIn).toBeWithin(7 * DAY - 30, 7 * DAY + 1);
  });

  test('a refresh unwraps, forwards the bare token, and re-wraps with the original time', async () => {
    const issuedAt = nowSeconds() - 3 * DAY;
    let requestedToken: unknown;
    const grant = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: await wrapRefreshToken('ghr_old', issuedAt, 'secret'),
      webURL: 'https://github.example.com',
      fetcher: (_input: RequestInfo | URL, init?: RequestInit) => {
        requestedToken = (
          JSON.parse(init?.body as string) as Record<string, unknown>
        ).refresh_token;
        return Promise.resolve(Response.json(GRANT_RESPONSE));
      },
    });
    expect(requestedToken).toBe('ghr_old');
    const unwrapped = await unwrapRefreshToken(
      grant.refreshToken ?? '',
      'secret'
    );
    expect(unwrapped).toEqual({ issuedAt, refreshToken: 'ghr_new' });
    // The browser is told only the session's remaining allowance, not a
    // fresh 7 days — the cap is absolute, not sliding.
    expect(grant.refreshTokenExpiresIn).toBeWithin(4 * DAY - 30, 4 * DAY + 1);
  });

  // One helper for every unrecoverable-session shape: the throwing fetcher
  // doubles as the assertion that GitHub is never contacted.
  async function expectRefreshRejected(refreshToken: string): Promise<void> {
    const rejected = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken,
      webURL: 'https://github.example.com',
      fetcher: () => {
        throw new Error('GitHub must not be contacted');
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);
  }

  test('over-age, bare, and foreign-wrapped tokens are rejected without contacting GitHub', async () => {
    const now = nowSeconds();
    await expectRefreshRejected(
      await wrapRefreshToken('ghr_old', now - 8 * DAY, 'secret')
    );
    await expectRefreshRejected('ghr_bare_predates_policy');
    await expectRefreshRejected(
      await wrapRefreshToken('ghr_old', now, 'other-secret')
    );
  });
});

// Opt-in at-rest encryption: with DIFFSHUB_TOKEN_ENCRYPTION_KEY configured,
// every grant leaves the server with its tokens sealed into dhe1 envelopes
// (lib/tokenSeal), and the refresh route opens submitted envelopes before
// contacting GitHub.
describe('token sealing under an encryption key', () => {
  const DAY = 24 * 3600;
  const KEY = new Uint8Array(32).fill(7);
  const GRANT_RESPONSE = {
    access_token: 'ghu_new',
    expires_in: 28_800,
    refresh_token: 'ghr_new',
    refresh_token_expires_in: 15_811_200,
  };

  useIsolatedEnvironment([
    'DIFFSHUB_GITHUB_CLIENT_ID',
    'DIFFSHUB_GITHUB_CLIENT_SECRET',
    'DIFFSHUB_REFRESH_TOKEN_MAX_TTL',
    'DIFFSHUB_REQUIRE_SEALED_TOKENS',
    'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
  ]);

  beforeEach(() => {
    process.env.DIFFSHUB_GITHUB_CLIENT_ID = 'id';
    process.env.DIFFSHUB_GITHUB_CLIENT_SECRET = 'secret';
    process.env.DIFFSHUB_TOKEN_ENCRYPTION_KEY =
      Buffer.from(KEY).toString('base64');
    resetGitHubEnvironmentCache();
  });

  test('a first sign-in seals both tokens', async () => {
    const now = nowSeconds();
    const grant = await exchangeOAuthCode({
      clientId: 'id',
      clientSecret: 'secret',
      code: 'code',
      redirectURI: 'https://diffs.example.com/api/auth/github/callback',
      webURL: 'https://github.example.com',
      fetcher: () => Promise.resolve(Response.json(GRANT_RESPONSE)),
    });
    expect(grant.accessToken.startsWith('dhe1.access.')).toBe(true);
    expect(await openSealedAccessToken(grant.accessToken, KEY)).toBe('ghu_new');
    const opened = await openSealedRefreshToken(grant.refreshToken ?? '', KEY);
    expect(opened?.refreshToken).toBe('ghr_new');
    expect(opened?.issuedAt).toBeWithin(now, now + 31);
    // Lifetimes stay GitHub's own — sealing changes representation, not policy.
    expect(grant.expiresIn).toBe(28_800);
    expect(grant.refreshTokenExpiresIn).toBe(15_811_200);
  });

  test('a refresh opens the envelope, forwards the bare token, and reseals with the original time', async () => {
    const issuedAt = nowSeconds() - 3 * DAY;
    let requestedToken: unknown;
    const grant = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: await sealRefreshToken('ghr_old', issuedAt, KEY),
      webURL: 'https://github.example.com',
      fetcher: (_input: RequestInfo | URL, init?: RequestInit) => {
        requestedToken = (
          JSON.parse(init?.body as string) as Record<string, unknown>
        ).refresh_token;
        return Promise.resolve(Response.json(GRANT_RESPONSE));
      },
    });
    expect(requestedToken).toBe('ghr_old');
    expect(await openSealedRefreshToken(grant.refreshToken ?? '', KEY)).toEqual(
      { issuedAt, refreshToken: 'ghr_new' }
    );
  });

  test('the envelope subsumes the dhr1 wrap when a max TTL is also set', async () => {
    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '7d';
    resetGitHubEnvironmentCache();
    const issuedAt = nowSeconds() - 3 * DAY;
    const grant = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      // A session wrapped before the key was configured still refreshes.
      refreshToken: await wrapRefreshToken('ghr_old', issuedAt, 'secret'),
      webURL: 'https://github.example.com',
      fetcher: () => Promise.resolve(Response.json(GRANT_RESPONSE)),
    });
    expect(grant.refreshToken?.startsWith('dhe1.refresh.')).toBe(true);
    expect(
      (await openSealedRefreshToken(grant.refreshToken ?? '', KEY))?.issuedAt
    ).toBe(issuedAt);
    // The clamp still reports only the session's remaining allowance.
    expect(grant.refreshTokenExpiresIn).toBeWithin(4 * DAY - 30, 4 * DAY + 1);
  });

  test('an envelope sealed under a rotated key is rejected without contacting GitHub', async () => {
    const sealed = await sealRefreshToken(
      'ghr_old',
      nowSeconds(),
      new Uint8Array(32).fill(9)
    );
    const rejected = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: sealed,
      webURL: 'https://github.example.com',
      fetcher: () => {
        throw new Error('GitHub must not be contacted');
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);
  });

  test('a bare refresh token is rejected when sealed tokens are required', async () => {
    process.env.DIFFSHUB_REQUIRE_SEALED_TOKENS = '1';
    resetGitHubEnvironmentCache();
    const rejected = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: 'ghr_bare_predates_key',
      webURL: 'https://github.example.com',
      fetcher: () => {
        throw new Error('GitHub must not be contacted');
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);
  });

  test('an over-age sealed session is rejected under a max TTL', async () => {
    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '7d';
    resetGitHubEnvironmentCache();
    const rejected = await refreshOAuthToken({
      clientId: 'id',
      clientSecret: 'secret',
      refreshToken: await sealRefreshToken(
        'ghr_old',
        nowSeconds() - 8 * DAY,
        KEY
      ),
      webURL: 'https://github.example.com',
      fetcher: () => {
        throw new Error('GitHub must not be contacted');
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown
    );
    expect(rejected).toBeInstanceOf(OAuthRefreshRejectedError);
  });
});
