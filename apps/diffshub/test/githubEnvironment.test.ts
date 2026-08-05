import { describe, expect, test } from 'bun:test';

import {
  createGitHubAPIURL,
  resolveGitHubEnvironment,
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
