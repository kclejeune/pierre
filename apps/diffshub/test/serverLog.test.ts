import { describe, expect, test } from 'bun:test';

import { logUpstreamFailure, sanitizeUpstreamURL } from '../lib/serverLog';
import { captureConsole, captureLogRecords } from './helpers/captureConsole';

describe('sanitizeUpstreamURL', () => {
  // Container logs are widely readable, so a query value never reaches them
  // unless it is on the allow-list.
  test('redacts query values that could carry an email or a signed token', () => {
    expect(
      sanitizeUpstreamURL(
        'https://ghe.corp.dev/api/v3/enterprise/avatars/u/e?email=me%40corp.dev&s=64'
      )
    ).toBe(
      'https://ghe.corp.dev/api/v3/enterprise/avatars/u/e?email=%5Bredacted%5D&s=64'
    );
    expect(
      sanitizeUpstreamURL('https://ghe.corp.dev/storage/user/1/x.png?token=abc')
    ).toBe('https://ghe.corp.dev/storage/user/1/x.png?token=%5Bredacted%5D');
  });

  test('keeps paths and replaces unparseable values', () => {
    expect(sanitizeUpstreamURL('https://ghe.corp.dev/avatars/u/4134')).toBe(
      'https://ghe.corp.dev/avatars/u/4134'
    );
    expect(sanitizeUpstreamURL('not a url?token=ghp_secret')).toBe(
      '[invalid URL]'
    );
  });
});

describe('logUpstreamFailure', () => {
  // On stderr so a log collector can separate failures from the access log.
  test('records the status, credential kind, and GitHub diagnostic headers on stderr', async () => {
    const [captured] = await captureConsole(() => {
      logUpstreamFailure({
        credential: 'deployment-avatar',
        response: new Response('nope', {
          headers: {
            'content-type': 'application/json',
            'x-accepted-oauth-scopes': 'repo',
            'x-github-request-id': 'abc-123',
            'x-oauth-scopes': '',
          },
          status: 404,
        }),
        route: 'github-web-asset',
        upstreamURL: 'https://ghe.corp.dev/api/v3/enterprise/avatars/u/e',
      });
    });

    expect(captured?.stream).toBe('stderr');
    expect(JSON.parse(captured?.line ?? '')).toMatchObject({
      credential: 'deployment-avatar',
      event: 'github_upstream_failure',
      level: 'error',
      route: 'github-web-asset',
      status: 404,
      'x-accepted-oauth-scopes': 'repo',
      'x-github-request-id': 'abc-123',
    });
  });

  test('records a thrown error when there is no response', async () => {
    const [record] = await captureLogRecords(() => {
      logUpstreamFailure({
        credential: 'none',
        error: new Error('getaddrinfo ENOTFOUND'),
        route: 'github-web-asset',
        upstreamURL: 'https://ghe.corp.dev/avatars/u/1',
      });
    });

    expect(record?.error).toBe('getaddrinfo ENOTFOUND');
    expect(record?.status).toBeUndefined();
  });

  test('never emits a credential value', async () => {
    const [record] = await captureLogRecords(() => {
      logUpstreamFailure({
        credential: 'viewer',
        response: new Response('', { status: 401 }),
        route: 'github-web-asset',
        upstreamURL: 'https://ghe.corp.dev/avatars/u/1?token=ghp_secret',
      });
    });

    expect(JSON.stringify(record)).not.toContain('ghp_secret');
  });
});
