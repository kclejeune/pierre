import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  createGitHubAPIURL,
  rejectTokenlessRequestWhenLoginRequired,
  resolveGitHubEnvironment,
  resolveRequestGitHubToken,
} from '../lib/githubEnvironment';

describe('resolveGitHubEnvironment', () => {
  test('defaults to public github.com', () => {
    expect(resolveGitHubEnvironment(undefined)).toEqual({
      apiURL: 'https://api.github.com',
      host: 'github.com',
      isGitHubDotCom: true,
      rawURL: 'https://raw.githubusercontent.com',
      webURL: 'https://github.com',
    });
  });

  test('empty string behaves like unset', () => {
    expect(resolveGitHubEnvironment('  ').isGitHubDotCom).toBe(true);
  });

  test('derives GHES API and raw roots from the base URL', () => {
    expect(resolveGitHubEnvironment('https://github.example.com')).toEqual({
      apiURL: 'https://github.example.com/api/v3',
      host: 'github.example.com',
      isGitHubDotCom: false,
      rawURL: 'https://github.example.com/raw',
      webURL: 'https://github.example.com',
    });
  });

  test('strips trailing slashes from the base URL', () => {
    const environment = resolveGitHubEnvironment('https://ghe.corp.dev/');
    expect(environment.webURL).toBe('https://ghe.corp.dev');
    expect(environment.apiURL).toBe('https://ghe.corp.dev/api/v3');
  });

  test('keeps a non-default port', () => {
    const environment = resolveGitHubEnvironment('https://ghe.corp.dev:8443');
    expect(environment.webURL).toBe('https://ghe.corp.dev:8443');
    expect(environment.host).toBe('ghe.corp.dev');
  });

  test('honors subdomain-isolation overrides', () => {
    expect(
      resolveGitHubEnvironment(
        'https://github.example.com',
        'https://api.github.example.com/',
        'https://raw.github.example.com'
      )
    ).toEqual({
      apiURL: 'https://api.github.example.com',
      host: 'github.example.com',
      isGitHubDotCom: false,
      rawURL: 'https://raw.github.example.com',
      webURL: 'https://github.example.com',
    });
  });

  test('rejects invalid and credentialed URLs', () => {
    expect(() => resolveGitHubEnvironment('not a url')).toThrow(
      'DIFFSHUB_GITHUB_URL'
    );
    expect(() =>
      resolveGitHubEnvironment('https://user:pass@ghe.corp.dev')
    ).toThrow('credentials');
    expect(() => resolveGitHubEnvironment('ftp://ghe.corp.dev')).toThrow(
      'http(s)'
    );
  });
});

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

describe('require-login token policy', () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'DIFFSHUB_REQUIRE_LOGIN',
    'DIFFSHUB_GITHUB_TOKEN',
    'GITHUB_TOKEN',
    'GH_TOKEN',
  ];

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      savedEnv[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] == null) {
        delete process.env[key];
      } else {
        process.env[key] = savedEnv[key];
      }
    }
  });

  test('tokenless requests get the fallback token on open deployments', () => {
    process.env.DIFFSHUB_GITHUB_TOKEN = 'server-token';
    expect(resolveRequestGitHubToken(createRequest())).toBe('server-token');
    expect(rejectTokenlessRequestWhenLoginRequired(createRequest())).toBeNull();
  });

  test('require-login refuses the fallback token for tokenless requests', () => {
    process.env.DIFFSHUB_GITHUB_TOKEN = 'server-token';
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    expect(resolveRequestGitHubToken(createRequest())).toBeUndefined();

    const rejection = rejectTokenlessRequestWhenLoginRequired(createRequest());
    expect(rejection?.status).toBe(401);
  });

  test('require-login passes requests carrying their own bearer token', () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = 'true';
    const request = createRequest('Bearer user-token');
    expect(resolveRequestGitHubToken(request)).toBe('user-token');
    expect(rejectTokenlessRequestWhenLoginRequired(request)).toBeNull();
  });

  test('unset and falsy DIFFSHUB_REQUIRE_LOGIN leave the gate open', () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '0';
    expect(rejectTokenlessRequestWhenLoginRequired(createRequest())).toBeNull();
  });
});

describe('createGitHubAPIURL', () => {
  test('joins paths onto path-prefixed API roots', () => {
    expect(
      createGitHubAPIURL(
        { apiURL: 'https://github.example.com/api/v3' },
        '/repos/owner/repo/pulls/1'
      )
    ).toBe('https://github.example.com/api/v3/repos/owner/repo/pulls/1');
  });

  test('appends search params', () => {
    expect(
      createGitHubAPIURL(
        { apiURL: 'https://api.github.com' },
        '/repos/owner/repo/contents/src/a.ts',
        { ref: 'abc123' }
      )
    ).toBe(
      'https://api.github.com/repos/owner/repo/contents/src/a.ts?ref=abc123'
    );
  });
});
