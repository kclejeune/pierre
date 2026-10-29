import { afterEach, beforeEach, mock } from 'bun:test';

import { resetGitHubEnvironmentCache } from '../../lib/githubEnvironment';
import {
  type PreferenceStore,
  setPreferenceStoreOverride,
} from '../../lib/preferenceStore';

// Shared setup for the /api/preferences route tests: an in-memory store, a
// fake GitHub /user endpoint, and a clean DiffsHub environment.

// Settings that change how the routes authenticate or pick a store. Cleared
// around each test so a developer shell's own DiffsHub configuration cannot
// leak in.
const CONFIG_KEYS = [
  'DIFFSHUB_GITHUB_URL',
  'DIFFSHUB_REDIS_URL',
  'NEXT_RUNTIME',
  'DIFFSHUB_REQUIRE_LOGIN',
  'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
] as const;

// Registers beforeEach/afterEach hooks that clear CONFIG_KEYS and then
// restore them, the global fetch, and normal store selection.
export function useCleanPreferenceRouteEnvironment(): void {
  const originalFetch = globalThis.fetch;
  const originalEnvironment = new Map(
    CONFIG_KEYS.map((key) => [key, process.env[key]] as const)
  );
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
}

// In-memory stand-in for Redis / Workers KV that also records each write's
// TTL.
export function createMemoryStore(): PreferenceStore & {
  data: Map<string, string>;
  ttls: Map<string, number | undefined>;
} {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  return {
    data,
    delete: (key) => {
      data.delete(key);
      return Promise.resolve();
    },
    get: (key) => Promise.resolve(data.get(key) ?? null),
    put: (key, value, options) => {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
      return Promise.resolve();
    },
    ttls,
  };
}

// Answers GET /user with a fixed id for any token and counts the calls.
export function mockGitHubUser(id: number) {
  const fetchMock = mock(() =>
    Promise.resolve(Response.json({ id, login: 'octocat' }))
  );
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

// Each call returns a fresh token so the routes' identity cache cannot leak a
// lookup between tests.
let tokenCounter = 0;
export function nextToken(): string {
  tokenCounter += 1;
  return `test-token-${tokenCounter}`;
}
