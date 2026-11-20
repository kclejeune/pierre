import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/github-suggest/route';
import { useCleanPreferenceRouteEnvironment } from './helpers/preferenceRouteKit';

useCleanPreferenceRouteEnvironment();

// Replaces fetch with one that records each GitHub URL and answers with
// `payload` and `status`.
function stubGitHub(payload: unknown, status = 200): string[] {
  const sent: string[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL) => {
    sent.push(input instanceof Request ? input.url : String(input));
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
        status,
      })
    );
  }) as unknown as typeof fetch;
  return sent;
}

function searchPulls(params: Record<string, string>) {
  const search = new URLSearchParams({ kind: 'pull-search', ...params });
  return GET(
    new NextRequest(`http://localhost/api/github-suggest?${search}`, {
      headers: { Authorization: 'Bearer test-token' },
    })
  );
}

describe('/api/github-suggest pull-search', () => {
  test('a number in named repositories is looked up directly', async () => {
    const sent = stubGitHub({
      number: 83,
      title: 'Fix',
      state: 'closed',
      merged_at: '2026-01-01T00:00:00Z',
    });
    const response = await searchPulls({ q: '#83', repos: 'octo/demo' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEndWith('/repos/octo/demo/pulls/83');
    expect(await response.json()).toEqual({
      pulls: [{ number: 83, repo: 'octo/demo', state: 'merged', title: 'Fix' }],
    });
  });

  test('a rejected token on a number lookup answers 401, not a miss', async () => {
    stubGitHub({ message: 'Bad credentials' }, 401);
    const response = await searchPulls({ q: '83', repos: 'octo/demo' });
    expect(response.status).toBe(401);
  });

  test('a number with no such pull is an empty result', async () => {
    stubGitHub({ message: 'Not Found' }, 404);
    const response = await searchPulls({ q: '83', repos: 'octo/demo' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ pulls: [] });
  });

  test('searches pull requests in the given repositories', async () => {
    const sent = stubGitHub({
      items: [
        {
          number: 83,
          title: 'Fix',
          state: 'open',
          repository_url: 'https://api.test/repos/octo/demo',
          pull_request: { merged_at: null },
        },
        {
          number: 9,
          title: 'Ship',
          state: 'closed',
          repository_url: 'https://api.test/repos/octo/other',
          pull_request: { merged_at: '2026-01-01T00:00:00Z' },
        },
        // An issue, not a pull request.
        {
          number: 5,
          title: 'Bug',
          state: 'open',
          repository_url: 'https://api.test/repos/octo/demo',
        },
      ],
    });
    const response = await searchPulls({
      q: 'fix',
      repos: 'octo/demo,octo/other',
    });
    expect(response.status).toBe(200);
    expect(new URL(sent[0] ?? '').searchParams.get('q')).toBe(
      'fix is:pr archived:false (repo:octo/demo OR repo:octo/other)'
    );
    expect(new URL(sent[0] ?? '').searchParams.get('advanced_search')).toBe(
      'true'
    );
    expect(await response.json()).toEqual({
      pulls: [
        { number: 83, repo: 'octo/demo', state: 'open', title: 'Fix' },
        { number: 9, repo: 'octo/other', state: 'merged', title: 'Ship' },
      ],
    });
  });

  test('groups an OR so the scope applies to every branch', async () => {
    const sent = stubGitHub({ items: [] });
    await searchPulls({ q: 'fix OR regression', repos: 'octo/demo' });
    expect(new URL(sent[0] ?? '').searchParams.get('q')).toBe(
      '(fix OR regression) is:pr archived:false repo:octo/demo'
    );
  });

  test('no repos parameter searches every repository', async () => {
    const sent = stubGitHub({ items: [] });
    await searchPulls({ q: 'fix' });
    expect(new URL(sent[0] ?? '').searchParams.get('q')).toBe(
      'fix is:pr archived:false'
    );
  });

  test('an empty repos list searches nothing', async () => {
    const sent = stubGitHub({ items: [] });
    const response = await searchPulls({ q: 'fix', repos: '' });
    expect(await response.json()).toEqual({ pulls: [] });
    expect(sent).toHaveLength(0);
  });

  test('a cancelled search answers quietly, not as GitHub unreachable', async () => {
    globalThis.fetch = mock(() =>
      Promise.reject(new DOMException('aborted', 'AbortError'))
    ) as unknown as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    const search = new URLSearchParams({ kind: 'pull-search', q: 'fix' });
    const response = await GET(
      new NextRequest(`http://localhost/api/github-suggest?${search}`, {
        headers: { Authorization: 'Bearer test-token' },
        signal: controller.signal,
      })
    );
    expect(response.status).toBe(499);
  });

  test('rejects a repository that would add search terms', async () => {
    const sent = stubGitHub({ items: [] });
    const response = await searchPulls({
      q: 'fix',
      repos: 'octo/demo is:merged',
    });
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });
});
