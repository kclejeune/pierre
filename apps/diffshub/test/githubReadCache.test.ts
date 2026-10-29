import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import {
  type CacheStore,
  type GitHubCacheLimits,
  readGitHubCacheLimits,
} from '@/lib/githubCacheStore';
import {
  countActiveGitHubCredentialQueues,
  githubFetch,
} from '@/lib/githubFetch';
import { createGitHubReads } from '@/lib/githubReadCache';

const REPO = { owner: 'Acme', repo: 'Widgets' };
const LIMITS: GitHubCacheLimits = {
  maxBytes: 1024 * 1024,
  maxEntries: 100,
  maxEntryBytes: 64 * 1024,
  ttlSeconds: 3600,
};
const KEY = new Uint8Array(32).fill(7);
const OTHER_KEY = new Uint8Array(32).fill(9);

const COMPARE = {
  base_commit: { commit: { tree: { sha: 'base-tree' } } },
  files: [
    {
      filename: 'src/secret-plans.ts',
      patch: '@@ big patch @@',
      sha: 'blob-1',
      status: 'modified',
    },
  ],
  merge_base_commit: { commit: { tree: { sha: 'mb-tree' } }, sha: 'mb' },
};

function memoryStore() {
  const entries = new Map<string, string>();
  const puts: { key: string; limits: GitHubCacheLimits }[] = [];
  const store: CacheStore = {
    get: (key) => Promise.resolve(entries.get(key) ?? null),
    put(key, value, limits) {
      entries.set(key, value);
      puts.push({ key, limits });
      return Promise.resolve();
    },
  };
  return { entries, puts, store };
}

// Replaces globalThis.fetch with a router over request paths and records
// every path (minus any GHES /api/v3 prefix), so tests can assert which reads
// went live.
let requested: string[] = [];
let routes: [RegExp, () => Response][] = [];
const realFetch = globalThis.fetch;
beforeEach(() => {
  requested = [];
  routes = [];
  globalThis.fetch = ((input: unknown) => {
    const path = new URL(String(input)).pathname.replace(/^\/api\/v3/, '');
    requested.push(path);
    const route = routes.find(([pattern]) => pattern.test(path));
    return Promise.resolve(
      route == null ? new Response('{}', { status: 404 }) : route[1]()
    );
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const json = (payload: unknown) => () =>
  new Response(JSON.stringify(payload), { status: 200 });

describe('createGitHubReads', () => {
  test('a hit is served after a live access check, without the live read', async () => {
    routes.push(
      [/\/compare\//, json(COMPARE)],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { store } = memoryStore();
    const first = await createGitHubReads('tok', {
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    expect(first.mergeBaseSha).toBe('mb');
    expect(requested.filter((path) => path.includes('/compare/'))).toHaveLength(
      1
    );

    requested = [];
    const second = await createGitHubReads('tok', {
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    expect(second).toEqual(first);
    // Only the access check reached GitHub.
    expect(requested).toEqual(['/repos/Acme/Widgets']);
  });

  test('a cached value is refused when the caller cannot read the repository', async () => {
    routes.push(
      [/\/compare\//, json(COMPARE)],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { store } = memoryStore();
    await createGitHubReads('owner-token', { limits: LIMITS, store }).compare(
      REPO,
      'a...b'
    );

    // The repo lookup now 404s for this caller; the hit must not be returned.
    routes = [];
    requested = [];
    const error = await createGitHubReads('outsider-token', {
      limits: LIMITS,
      store,
    })
      .compare(REPO, 'a...b')
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect(requested).toEqual(['/repos/Acme/Widgets']);
  });

  test('repos the caller already read skip the access check', async () => {
    routes.push([/\/compare\//, json(COMPARE)]);
    const { store } = memoryStore();
    const reads = () =>
      createGitHubReads('tok', {
        accessibleRepos: [{ owner: 'acme', repo: 'widgets' }],
        limits: LIMITS,
        store,
      });
    await reads().compare(REPO, 'a...b');
    requested = [];
    expect((await reads().compare(REPO, 'a...b')).mergeBaseSha).toBe('mb');
    expect(requested).toEqual([]);
  });

  test('the summary drops patches and keeps only what planning reads', async () => {
    routes.push([/\/compare\//, json(COMPARE)]);
    const { entries, store } = memoryStore();
    await createGitHubReads('tok', {
      encryptionKey: undefined,
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    const [value] = [...entries.values()];
    expect(value?.startsWith('p1.')).toBe(true);
    expect(value).not.toContain('big patch');
    expect(JSON.parse(value?.slice(3) ?? '')).toEqual({
      baseTreeSha: 'base-tree',
      files: [
        { filename: 'src/secret-plans.ts', sha: 'blob-1', status: 'modified' },
      ],
      mergeBaseSha: 'mb',
      mergeBaseTreeSha: 'mb-tree',
    });
  });

  test('with an instance key, keys and values reveal no repository data', async () => {
    routes.push(
      [/\/compare\//, json(COMPARE)],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { entries, store } = memoryStore();
    await createGitHubReads('tok', {
      encryptionKey: KEY,
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    const [[key, value] = ['', '']] = [...entries];
    for (const text of [key, value]) {
      expect(text.toLowerCase()).not.toContain('widgets');
      expect(text).not.toContain('secret-plans');
    }
    expect(value.startsWith('e1.')).toBe(true);

    // The same key reads it back; a different key misses and reads live.
    requested = [];
    await createGitHubReads('tok', {
      encryptionKey: KEY,
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    expect(requested.some((path) => path.includes('/compare/'))).toBe(false);
    requested = [];
    await createGitHubReads('tok', {
      encryptionKey: OTHER_KEY,
      limits: LIMITS,
      store,
    }).compare(REPO, 'a...b');
    expect(requested.some((path) => path.includes('/compare/'))).toBe(true);
  });

  test('a tampered sealed value is a miss, not an error', async () => {
    routes.push(
      [/\/compare\//, json(COMPARE)],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { entries, store } = memoryStore();
    const reads = () =>
      createGitHubReads('tok', { encryptionKey: KEY, limits: LIMITS, store });
    await reads().compare(REPO, 'a...b');
    const [key = ''] = entries.keys();
    entries.set(key, `${entries.get(key)?.slice(0, -4)}AAAA`);
    requested = [];
    expect((await reads().compare(REPO, 'a...b')).mergeBaseSha).toBe('mb');
    expect(requested.some((path) => path.includes('/compare/'))).toBe(true);
  });

  test('blobs are read raw and cached by SHA', async () => {
    routes.push(
      [/\/git\/blobs\/b1$/, () => new Response('file text')],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { store } = memoryStore();
    const reads = () => createGitHubReads('tok', { limits: LIMITS, store });
    expect(await reads().blob(REPO, 'b1')).toBe('file text');
    requested = [];
    expect(await reads().blob(REPO, 'b1')).toBe('file text');
    expect(requested).toEqual(['/repos/Acme/Widgets']);
  });

  test('values over the entry cap are not stored', async () => {
    routes.push([/\/git\/blobs\//, () => new Response('x'.repeat(2048))]);
    const { puts, store } = memoryStore();
    await createGitHubReads('tok', {
      limits: { ...LIMITS, maxEntryBytes: 1024 },
      store,
    }).blob(REPO, 'big');
    expect(puts).toEqual([]);
  });

  test('store failures fall back to live reads', async () => {
    routes.push([/\/compare\//, json(COMPARE)]);
    const failing: CacheStore = {
      get: () => Promise.reject(new Error('store down')),
      put: () => Promise.reject(new Error('store down')),
    };
    const summary = await createGitHubReads('tok', {
      limits: LIMITS,
      store: failing,
    }).compare(REPO, 'a...b');
    expect(summary.mergeBaseSha).toBe('mb');
  });

  test('tree listings are cached and served as maps', async () => {
    routes.push(
      [
        /\/git\/trees\/t1$/,
        json({
          tree: [{ mode: '100644', path: 'a.ts', sha: 's1', type: 'blob' }],
        }),
      ],
      [/^\/repos\/Acme\/Widgets$/, json({})]
    );
    const { store } = memoryStore();
    const list = () =>
      createGitHubReads('tok', { limits: LIMITS, store }).treeLister(REPO)(
        't1'
      );
    const first = await list();
    requested = [];
    const second = await list();
    expect(second).toEqual(first);
    expect(second.get('a.ts')?.sha).toBe('s1');
    expect(requested.some((path) => path.includes('/git/trees/'))).toBe(false);
  });

  test('a disabled cache never touches the store', async () => {
    routes.push([/\/compare\//, json(COMPARE)]);
    const { puts, store } = memoryStore();
    await createGitHubReads('tok', { limits: null, store }).compare(
      REPO,
      'a...b'
    );
    expect(puts).toEqual([]);
  });
});

describe('readGitHubCacheLimits', () => {
  const NAMES = [
    'DIFFSHUB_GITHUB_CACHE_TTL',
    'DIFFSHUB_GITHUB_CACHE_MAX_BYTES',
    'DIFFSHUB_GITHUB_CACHE_MAX_ENTRY_BYTES',
    'DIFFSHUB_GITHUB_CACHE_MAX_ENTRIES',
  ];
  const saved = Object.fromEntries(
    NAMES.map((name) => [name, process.env[name]])
  );
  afterEach(() => {
    for (const name of NAMES) {
      if (saved[name] == null) {
        delete process.env[name];
      } else {
        process.env[name] = saved[name];
      }
    }
  });

  test('defaults apply when unset', () => {
    for (const name of NAMES) {
      delete process.env[name];
    }
    expect(readGitHubCacheLimits()).toEqual({
      maxBytes: 1024 * 1024 * 1024,
      maxEntries: 100_000,
      maxEntryBytes: 1024 * 1024,
      ttlSeconds: 86_400,
    });
  });

  test('a zero TTL turns the cache off', () => {
    process.env.DIFFSHUB_GITHUB_CACHE_TTL = '0';
    expect(readGitHubCacheLimits()).toBeNull();
  });

  test('sizes accept suffixes and the entry cap never exceeds the total', () => {
    process.env.DIFFSHUB_GITHUB_CACHE_TTL = '6h';
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_BYTES = '512k';
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_ENTRY_BYTES = '1m';
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_ENTRIES = '10';
    expect(readGitHubCacheLimits()).toEqual({
      maxBytes: 512 * 1024,
      maxEntries: 10,
      maxEntryBytes: 512 * 1024,
      ttlSeconds: 6 * 3600,
    });
  });

  test('malformed values throw', () => {
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_BYTES = 'lots';
    expect(() => readGitHubCacheLimits()).toThrow();
    delete process.env.DIFFSHUB_GITHUB_CACHE_MAX_BYTES;
    process.env.DIFFSHUB_GITHUB_CACHE_MAX_ENTRIES = '-1';
    expect(() => readGitHubCacheLimits()).toThrow();
  });
});

describe('githubFetch', () => {
  test('limits in-flight requests per credential, independently', async () => {
    const active = new Map<string, number>();
    const peak = new Map<string, number>();
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get('authorization') ?? '';
      active.set(auth, (active.get(auth) ?? 0) + 1);
      peak.set(auth, Math.max(peak.get(auth) ?? 0, active.get(auth) ?? 0));
      await new Promise((resolve) => setTimeout(resolve, 2));
      active.set(auth, (active.get(auth) ?? 0) - 1);
      return new Response('ok');
    }) as typeof fetch;
    const burst = (auth: string) =>
      Array.from({ length: 40 }, () =>
        githubFetch('https://api.github.com/x', {
          headers: { Authorization: auth },
        })
      );
    await Promise.all([...burst('Bearer a'), ...burst('Bearer b')]);
    expect(peak.get('Bearer a')).toBe(16);
    expect(peak.get('Bearer b')).toBe(16);
    // Idle credentials are not retained.
    expect(countActiveGitHubCredentialQueues()).toBe(0);
  });
});
