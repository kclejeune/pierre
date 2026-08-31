import { afterEach, describe, expect, test } from 'bun:test';

import {
  createGitHubAPIURL,
  getRefreshTokenMaxTTLSeconds,
  isConfiguredGitHubInstanceURL,
  isPATInputEnabled,
  parseDurationSeconds,
  resetGitHubEnvironmentCache,
  resolveGitHubEnvironment,
} from '../lib/githubEnvironment';
import { useIsolatedEnvironment } from './helpers/env';

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

// The gate every outbound request must clear before it may carry a viewer's
// token. The CDN case is the one that matters: resolveGitHubPath answers with
// diffshub.pierrecdn.com for the cached example patches, and the authenticated
// retry of one of those must not inherit the token.
describe('isConfiguredGitHubInstanceURL', () => {
  const savedURL = process.env.DIFFSHUB_GITHUB_URL;

  afterEach(() => {
    if (savedURL == null) {
      delete process.env.DIFFSHUB_GITHUB_URL;
    } else {
      process.env.DIFFSHUB_GITHUB_URL = savedURL;
    }
    resetGitHubEnvironmentCache();
  });

  function useInstance(url?: string): void {
    if (url == null) {
      delete process.env.DIFFSHUB_GITHUB_URL;
    } else {
      process.env.DIFFSHUB_GITHUB_URL = url;
    }
    resetGitHubEnvironmentCache();
  }

  test('accepts URLs on the configured instance', () => {
    useInstance();
    expect(
      isConfiguredGitHubInstanceURL('https://github.com/owner/repo/pull/1.diff')
    ).toBe(true);

    useInstance('https://ghe.corp.dev');
    expect(
      isConfiguredGitHubInstanceURL('https://ghe.corp.dev/owner/repo/pull/1')
    ).toBe(true);
  });

  test('rejects the cached-patch CDN and other foreign hosts', () => {
    useInstance();
    expect(
      isConfiguredGitHubInstanceURL(
        'https://diffshub.pierrecdn.com/patches/30412.diff'
      )
    ).toBe(false);
    expect(
      isConfiguredGitHubInstanceURL(
        'https://patch-diff.githubusercontent.com/raw/o/r/pull/1.diff'
      )
    ).toBe(false);
    expect(
      isConfiguredGitHubInstanceURL('https://github.com.evil.example/x')
    ).toBe(false);
  });

  test('matches a path-prefixed root by origin, and rejects unparseable input', () => {
    useInstance('https://ghe.corp.dev/github');
    expect(
      isConfiguredGitHubInstanceURL('https://ghe.corp.dev/owner/repo/pull/1')
    ).toBe(true);
    expect(isConfiguredGitHubInstanceURL('not a url')).toBe(false);
  });
});

describe('token policy environment flags', () => {
  useIsolatedEnvironment([
    'DIFFSHUB_ENABLE_PAT_INPUT',
    'DIFFSHUB_REFRESH_TOKEN_MAX_TTL',
    'DIFFSHUB_REQUIRE_LOGIN',
    'DIFFSHUB_GITHUB_CLIENT_ID',
  ]);

  test('PAT input is offered by default on open deployments', () => {
    expect(isPATInputEnabled()).toBe(true);
  });

  test('require-login with OAuth configured hides PAT input by default', () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    process.env.DIFFSHUB_GITHUB_CLIENT_ID = 'Iv1.example';
    expect(isPATInputEnabled()).toBe(false);
  });

  // Without OAuth a PAT is the only way through the login gate, so hiding
  // the box by default would lock every viewer out.
  test('require-login without OAuth keeps PAT input on', () => {
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    expect(isPATInputEnabled()).toBe(true);
  });

  test('an explicit DIFFSHUB_ENABLE_PAT_INPUT overrides the default', () => {
    process.env.DIFFSHUB_ENABLE_PAT_INPUT = '0';
    expect(isPATInputEnabled()).toBe(false);

    process.env.DIFFSHUB_ENABLE_PAT_INPUT = 'true';
    process.env.DIFFSHUB_REQUIRE_LOGIN = '1';
    process.env.DIFFSHUB_GITHUB_CLIENT_ID = 'Iv1.example';
    expect(isPATInputEnabled()).toBe(true);
  });

  test('the max TTL parses through its three states', () => {
    expect(getRefreshTokenMaxTTLSeconds()).toBeUndefined();

    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '0';
    resetGitHubEnvironmentCache();
    expect(getRefreshTokenMaxTTLSeconds()).toBe(0);

    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = '24h';
    resetGitHubEnvironmentCache();
    expect(getRefreshTokenMaxTTLSeconds()).toBe(24 * 3600);
  });

  test('a malformed max TTL fails loudly rather than running uncapped', () => {
    process.env.DIFFSHUB_REFRESH_TOKEN_MAX_TTL = 'soon';
    expect(() => getRefreshTokenMaxTTLSeconds()).toThrow(
      'DIFFSHUB_REFRESH_TOKEN_MAX_TTL'
    );
  });
});

describe('parseDurationSeconds', () => {
  test('accepts bare seconds and s/m/h/d suffixes', () => {
    expect(parseDurationSeconds('86400', 'X')).toBe(86_400);
    expect(parseDurationSeconds('90s', 'X')).toBe(90);
    expect(parseDurationSeconds('30m', 'X')).toBe(1800);
    expect(parseDurationSeconds('8H', 'X')).toBe(8 * 3600);
    expect(parseDurationSeconds('7d', 'X')).toBe(7 * 86_400);
  });

  test('unset means no cap', () => {
    expect(parseDurationSeconds(undefined, 'X')).toBeUndefined();
    expect(parseDurationSeconds('  ', 'X')).toBeUndefined();
  });

  test('zero is a valid duration (the policy reads it as "issue none")', () => {
    expect(parseDurationSeconds('0', 'X')).toBe(0);
    expect(parseDurationSeconds('0h', 'X')).toBe(0);
  });

  test('rejects malformed durations', () => {
    expect(() => parseDurationSeconds('1.5h', 'X')).toThrow('X');
    expect(() => parseDurationSeconds('-1', 'X')).toThrow('X');
    expect(() => parseDurationSeconds('1w', 'X')).toThrow('X');
  });
});
