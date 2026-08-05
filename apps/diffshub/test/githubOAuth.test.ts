import { describe, expect, test } from 'bun:test';

import {
  buildAuthorizeURL,
  buildCompletionURL,
  exchangeOAuthCode,
  getPublicOrigin,
  parseOAuthState,
  sanitizeReturnTo,
  serializeOAuthState,
} from '../lib/githubOAuth';

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
      returnTo: '/owner/repo/pull/1',
      token: 'gho_secret',
    });
    expect(url).toBe(
      '/auth/github?returnTo=%2Fowner%2Frepo%2Fpull%2F1#token=gho_secret'
    );
    expect(url.split('#')[0]).not.toContain('gho_secret');
  });

  test('omits the default return path and carries errors as query', () => {
    expect(buildCompletionURL({ error: 'nope', returnTo: '/' })).toBe(
      '/auth/github?error=nope'
    );
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
    const token = await exchangeOAuthCode({
      ...baseOptions,
      fetcher: (input: RequestInfo | URL, init?: RequestInit) => {
        requestedURL = String(input);
        requestedBody = JSON.parse(init?.body as string);
        return Promise.resolve(Response.json({ access_token: 'gho_token' }));
      },
    });
    expect(token).toBe('gho_token');
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
});
