import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { DELETE, GET, PUT } from '../app/api/preferences/route';
import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';
import {
  getPreferenceStore,
  type PreferenceStore,
  setPreferenceStoreOverride,
  validatePreferenceStoreConfiguration,
} from '../lib/preferenceStore';

const originalFetch = globalThis.fetch;
const CONFIG_KEYS = [
  'DIFFSHUB_GITHUB_URL',
  'DIFFSHUB_REDIS_URL',
  'NEXT_RUNTIME',
  'DIFFSHUB_REQUIRE_LOGIN',
  'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
] as const;
const originalEnvironment = new Map(
  CONFIG_KEYS.map((key) => [key, process.env[key]] as const)
);

// In-memory stand-in for Redis / Workers KV.
function createMemoryStore(): PreferenceStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value) => {
      data.set(key, value);
      return Promise.resolve();
    },
  };
}

// Answers GET /user with a fixed id for any token and counts the calls.
function mockGitHubUser(id: number) {
  const fetchMock = mock(() =>
    Promise.resolve(Response.json({ id, login: 'octocat' }))
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// Each test uses its own token so the route's identity cache cannot leak
// a lookup between tests.
let tokenCounter = 0;
function nextToken(): string {
  tokenCounter += 1;
  return `test-token-${tokenCounter}`;
}

function request(
  method: string,
  token: string | undefined,
  body?: unknown
): NextRequest {
  const headers: Record<string, string> = {};
  if (token != null) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  return new NextRequest('https://diffshub.com/api/preferences', {
    body: body === undefined ? undefined : JSON.stringify(body),
    headers,
    method,
  });
}

beforeEach(() => {
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
  resetGitHubEnvironmentCache();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  setPreferenceStoreOverride(null);
  for (const key of CONFIG_KEYS) {
    const value = originalEnvironment.get(key);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetGitHubEnvironmentCache();
});

describe('/api/preferences', () => {
  test('reports itself disabled when no store is configured', async () => {
    setPreferenceStoreOverride(undefined);
    const response = await GET(request('GET', nextToken()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ enabled: false, preferences: {} });

    const write = await PUT(
      request('PUT', nextToken(), { preferences: { theme: 'x' } })
    );
    expect(write.status).toBe(404);
  });

  test('requires a token', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    const response = await GET(request('GET', undefined));
    expect(response.status).toBe(401);
  });

  test('stores preferences under the GitHub user id, never the token', async () => {
    const store = createMemoryStore();
    setPreferenceStoreOverride(store);
    const fetchMock = mockGitHubUser(583231);
    const token = nextToken();

    const write = await PUT(
      request('PUT', token, {
        preferences: { diffStyle: 'split', pinnedRepos: ['acme/widgets'] },
      })
    );
    expect(write.status).toBe(200);
    expect([...store.data.keys()]).toEqual([
      'diffshub:preferences:v1:https://github.com:583231',
    ]);
    const stored = [...store.data.values()].join('');
    expect(stored).not.toContain(token);

    // A different token for the same user reads the same preferences.
    const read = await GET(request('GET', nextToken()));
    expect(await read.json()).toEqual({
      enabled: true,
      preferences: { diffStyle: 'split', pinnedRepos: ['acme/widgets'] },
    });

    // The identity lookup for the first token is cached across requests.
    await GET(request('GET', token));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('namespaces keys by the full instance URL, not just the host', async () => {
    const store = createMemoryStore();
    setPreferenceStoreOverride(store);
    mockGitHubUser(21);
    process.env.DIFFSHUB_GITHUB_URL = 'https://ghe.example.com:8443/github';
    resetGitHubEnvironmentCache();
    await PUT(request('PUT', nextToken(), { preferences: { a: 1 } }));
    expect([...store.data.keys()]).toEqual([
      'diffshub:preferences:v1:https://ghe.example.com:8443/github:21',
    ]);
  });

  test('merges partial updates and deletes null keys', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    mockGitHubUser(7);
    const token = nextToken();
    await PUT(request('PUT', token, { preferences: { a: 1, b: 2 } }));
    const response = await PUT(
      request('PUT', token, { preferences: { a: null, c: 3 } })
    );
    expect((await response.json()).preferences).toEqual({ b: 2, c: 3 });
  });

  test('skips the store write when nothing changed', async () => {
    const store = createMemoryStore();
    const put = mock(store.put);
    const remove = mock(store.delete);
    setPreferenceStoreOverride({ ...store, delete: remove, put });
    mockGitHubUser(17);
    const token = nextToken();
    await PUT(request('PUT', token, { preferences: { a: 1 } }));
    await PUT(request('PUT', token, { preferences: { a: 1 } }));
    await PUT(request('PUT', token, { preferences: { missing: null } }));
    expect(put).toHaveBeenCalledTimes(1);
    expect(remove).not.toHaveBeenCalled();
  });

  test("refuses to store the caller's own token or credential shapes", async () => {
    const store = createMemoryStore();
    setPreferenceStoreOverride(store);
    mockGitHubUser(9);
    const token = nextToken();

    const ownToken = await PUT(
      request('PUT', token, { preferences: { note: `copy of ${token}` } })
    );
    expect(ownToken.status).toBe(400);

    const ghToken = await PUT(
      request('PUT', token, {
        preferences: { note: `ghp_${'a'.repeat(36)}` },
      })
    );
    expect(ghToken.status).toBe(400);

    const sealed = await PUT(
      request('PUT', token, {
        preferences: { theme: 'dhe1.access.bm9uY2U.Y2lwaGVy' },
      })
    );
    expect(sealed.status).toBe(400);
    expect(store.data.size).toBe(0);

    // Credential-sounding names are fine when the value is not a credential.
    const named = await PUT(
      request('PUT', token, { preferences: { authorFilter: 'octocat' } })
    );
    expect(named.status).toBe(200);
  });

  test('rejects malformed bodies', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    mockGitHubUser(11);
    const response = await PUT(request('PUT', nextToken(), { theme: 'x' }));
    expect(response.status).toBe(400);
  });

  test('relays a GitHub rejection of the token', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    globalThis.fetch = mock(() =>
      Promise.resolve(
        Response.json({ message: 'Bad credentials' }, { status: 401 })
      )
    ) as unknown as typeof fetch;
    const response = await GET(request('GET', nextToken()));
    expect(response.status).toBe(401);
  });

  test('DELETE removes everything for the caller', async () => {
    const store = createMemoryStore();
    setPreferenceStoreOverride(store);
    mockGitHubUser(13);
    const token = nextToken();
    await PUT(request('PUT', token, { preferences: { a: 1 } }));
    const response = await DELETE(request('DELETE', token));
    expect(await response.json()).toEqual({ enabled: true, preferences: {} });
    expect(store.data.size).toBe(0);
  });

  test('answers 503 when the store fails', async () => {
    const down = () => Promise.reject(new Error('down'));
    setPreferenceStoreOverride({ delete: down, get: down, put: down });
    mockGitHubUser(15);
    const response = await GET(request('GET', nextToken()));
    expect(response.status).toBe(503);
  });
});

describe('preference store selection', () => {
  test('falls back to no store without Redis or a Workers KV binding', async () => {
    // No override: exercises the real Redis-then-KV selection, where
    // getCloudflareContext throws outside a Worker. beforeEach has already
    // cleared DIFFSHUB_REDIS_URL. NEXT_RUNTIME=nodejs is what production Node
    // sets; it must not start a Wrangler platform proxy.
    process.env.NEXT_RUNTIME = 'nodejs';
    expect(await getPreferenceStore()).toBeUndefined();
    const response = await GET(request('GET', nextToken()));
    expect(await response.json()).toEqual({
      enabled: false,
      preferences: {},
    });
  });

  test('validates DIFFSHUB_REDIS_URL with the client parser rules', () => {
    for (const url of [
      'redis://valkey:6379',
      'rediss://:p%40ss@valkey:6380/2',
      'redis://user:pw@valkey/',
    ]) {
      process.env.DIFFSHUB_REDIS_URL = url;
      expect(() => validatePreferenceStoreConfiguration()).not.toThrow();
    }
    for (const url of [
      'https://valkey:6379',
      'redis://valkey:6379/not-a-db',
      'redis://valkey:6379/1.5',
      'redis://:p%ZZ@valkey:6379',
    ]) {
      process.env.DIFFSHUB_REDIS_URL = url;
      expect(() => validatePreferenceStoreConfiguration()).toThrow();
    }
  });
});
