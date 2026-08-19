import { describe, expect, test } from 'bun:test';

import {
  buildAuthorizeURL,
  buildCompletionURL,
  exchangeOAuthCode,
  getPublicOrigin,
  OAuthRefreshRejectedError,
  parseOAuthState,
  refreshOAuthToken,
  sanitizeReturnTo,
  serializeOAuthState,
} from '../lib/githubOAuth';
import { parseGrantFragment } from '../lib/githubOAuthGrant';

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
});
