import { describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET, POST } from '../app/api/pull-reviewers/route';
import { useCleanPreferenceRouteEnvironment } from './helpers/preferenceRouteKit';

useCleanPreferenceRouteEnvironment();

interface SentRequest {
  body: unknown;
  method: string;
  url: string;
}

// Replaces fetch with one that records each GitHub request and answers
// with `payload`.
function stubGitHub(payload: unknown): SentRequest[] {
  const sent: SentRequest[] = [];
  globalThis.fetch = mock((input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      method: init?.method ?? 'GET',
      url: input instanceof Request ? input.url : String(input),
    });
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        headers: { 'Content-Type': 'application/json' },
      })
    );
  }) as unknown as typeof fetch;
  return sent;
}

function postChange(body: object) {
  return POST(
    new NextRequest('http://localhost/api/pull-reviewers', {
      body: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      method: 'POST',
    })
  );
}

const PULL_AFTER_CHANGE = {
  requested_reviewers: [{ avatar_url: 'https://a/1', login: 'octocat' }],
  requested_teams: [{ slug: 'core' }],
};

describe('/api/pull-reviewers', () => {
  test('add posts the login to requested_reviewers', async () => {
    const sent = stubGitHub(PULL_AFTER_CHANGE);
    const response = await postChange({
      action: 'add',
      login: 'octocat',
      owner: 'o',
      pull: '7',
      repo: 'r',
    });
    expect(response.status).toBe(200);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toEndWith('/repos/o/r/pulls/7/requested_reviewers');
    expect(sent[0]?.body).toEqual({ reviewers: ['octocat'] });
    expect(await response.json()).toEqual({
      reviewers: [
        { avatarUrl: 'https://a/1', login: 'octocat', state: 'PENDING' },
        { login: 'core', state: 'PENDING', team: true },
      ],
    });
  });

  test('remove sends a DELETE with the login', async () => {
    const sent = stubGitHub({ requested_reviewers: [], requested_teams: [] });
    const response = await postChange({
      action: 'remove',
      login: 'octocat',
      owner: 'o',
      pull: '7',
      repo: 'r',
    });
    expect(response.status).toBe(200);
    expect(sent[0]?.method).toBe('DELETE');
    expect(sent[0]?.body).toEqual({ reviewers: ['octocat'] });
    expect(await response.json()).toEqual({ reviewers: [] });
  });

  test('rejects an invalid login without calling GitHub', async () => {
    const sent = stubGitHub({});
    const response = await postChange({
      action: 'add',
      login: 'org/team',
      owner: 'o',
      pull: '7',
      repo: 'r',
    });
    expect(response.status).toBe(400);
    expect(sent).toHaveLength(0);
  });

  test('GET searches the repository assignable users', async () => {
    const sent = stubGitHub({
      data: {
        repository: {
          assignableUsers: { nodes: [{ login: 'octocat', name: 'Octo' }] },
        },
      },
    });
    const response = await GET(
      new NextRequest(
        'http://localhost/api/pull-reviewers?owner=o&repo=r&q=oct',
        { headers: { Authorization: 'Bearer test-token' } }
      )
    );
    expect(response.status).toBe(200);
    expect(sent[0]?.url).toEndWith('/graphql');
    const body = sent[0]?.body as
      | { variables: Record<string, string> }
      | undefined;
    expect(body?.variables).toEqual({ name: 'r', owner: 'o', query: 'oct' });
    expect(await response.json()).toEqual({
      candidates: [{ login: 'octocat', name: 'Octo' }],
    });
  });
});
