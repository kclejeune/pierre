import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  getGitHubTokenSnapshot,
  GITHUB_TOKEN_CHANGE_EVENT,
  isStoredGitHubTokenExpired,
  nextGitHubRefreshDueAt,
  readStoredGitHubSession,
  readStoredGitHubToken,
  refreshGitHubSessionIfNeeded,
  saveGitHubGrantToStorage,
  saveGitHubTokenToStorage,
} from '@/components/githubSession';
import { type PlainFetch } from '@/lib/plainFetch';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
});

afterEach(() => {
  globalThis.window = originalWindow;
});

const HOUR_MS = 60 * 60 * 1000;

const EXPIRING_GRANT = {
  accessToken: 'ghu_access',
  expiresIn: 8 * 3600,
  refreshToken: 'ghr_refresh',
  refreshTokenExpiresIn: 183 * 24 * 3600,
};

// A fetch stub that records the refresh request and answers with `response`.
function refreshFetcher(response: () => Response): {
  calls: { url: string; body: unknown }[];
  fetcher: PlainFetch;
} {
  const calls: { url: string; body: unknown }[] = [];
  const fetcher: PlainFetch = (input, init) => {
    calls.push({ url: String(input), body: JSON.parse(init?.body as string) });
    return Promise.resolve(response());
  };
  return { calls, fetcher };
}

describe('token and session storage', () => {
  test('a pasted token stores no session and clears a previous one', () => {
    const now = 1_000_000;
    saveGitHubGrantToStorage(EXPIRING_GRANT, now);
    expect(readStoredGitHubSession()?.refreshToken).toBe('ghr_refresh');

    saveGitHubTokenToStorage('ghp_pat');
    expect(readStoredGitHubToken()).toBe('ghp_pat');
    expect(readStoredGitHubSession()).toBeUndefined();
    expect(nextGitHubRefreshDueAt()).toBeUndefined();
  });

  test('a non-expiring grant stores only the token', () => {
    saveGitHubGrantToStorage({ accessToken: 'gho_plain' });
    expect(readStoredGitHubToken()).toBe('gho_plain');
    expect(readStoredGitHubSession()).toBeUndefined();
  });

  test('an expiring grant anchors lifetimes to the supplied clock', () => {
    const now = 1_000_000;
    saveGitHubGrantToStorage(EXPIRING_GRANT, now);
    expect(readStoredGitHubSession()).toEqual({
      expiresAt: now + 8 * HOUR_MS,
      refreshToken: 'ghr_refresh',
      refreshTokenExpiresAt: now + 183 * 24 * HOUR_MS,
    });
    expect(isStoredGitHubTokenExpired(now + 8 * HOUR_MS - 1)).toBe(false);
    expect(isStoredGitHubTokenExpired(now + 8 * HOUR_MS)).toBe(true);
    expect(nextGitHubRefreshDueAt()).toBe(now + 8 * HOUR_MS - 5 * 60_000);
  });

  test('clearing the token clears the session and notifies listeners', () => {
    const now = 1_000_000;
    saveGitHubGrantToStorage(EXPIRING_GRANT, now);
    saveGitHubTokenToStorage('');
    expect(readStoredGitHubToken()).toBe('');
    expect(readStoredGitHubSession()).toBeUndefined();
    expect(fake.events.map((event) => event.type)).toEqual([
      GITHUB_TOKEN_CHANGE_EVENT,
      GITHUB_TOKEN_CHANGE_EVENT,
    ]);
  });
});

describe('getGitHubTokenSnapshot', () => {
  // useSyncExternalStore needs the same object back until the token really
  // changes, and a version that ticks exactly once per change.
  test('keeps identity while the token is unchanged and bumps on change', () => {
    saveGitHubTokenToStorage('ghp_one');
    const first = getGitHubTokenSnapshot();
    expect(first.token).toBe('ghp_one');
    expect(getGitHubTokenSnapshot()).toBe(first);

    saveGitHubTokenToStorage('ghp_two');
    const second = getGitHubTokenSnapshot();
    expect(second).not.toBe(first);
    expect(second.token).toBe('ghp_two');
    expect(second.version).toBe(first.version + 1);
  });
});

describe('refreshGitHubSessionIfNeeded', () => {
  test('is a no-op without a refreshable session', async () => {
    const { calls, fetcher } = refreshFetcher(() => Response.json({}));
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('none');

    saveGitHubTokenToStorage('ghp_pat');
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('none');
    expect(calls).toHaveLength(0);
  });

  test('leaves a token alone while it is far from expiring', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { calls, fetcher } = refreshFetcher(() => Response.json({}));
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('fresh');
    expect(calls).toHaveLength(0);
  });

  test('refreshes an expiring token and stores the rotated grant', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now() - 8 * HOUR_MS);
    const { calls, fetcher } = refreshFetcher(() =>
      Response.json({
        access_token: 'ghu_next',
        expires_in: 28800,
        refresh_token: 'ghr_next',
        refresh_token_expires_in: 15811200,
      })
    );
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('refreshed');
    expect(calls).toEqual([
      {
        url: '/api/auth/github/refresh',
        body: { refreshToken: 'ghr_refresh' },
      },
    ]);
    expect(readStoredGitHubToken()).toBe('ghu_next');
    expect(readStoredGitHubSession()?.refreshToken).toBe('ghr_next');
    expect(isStoredGitHubTokenExpired()).toBe(false);
  });

  // GitHub rotates refresh tokens, so two overlapping refreshes must share
  // one request or the second would be rejected as already used.
  test('coalesces concurrent refreshes into one request', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now() - 8 * HOUR_MS);
    const { calls, fetcher } = refreshFetcher(() =>
      Response.json({ access_token: 'ghu_next', refresh_token: 'ghr_next' })
    );
    const outcomes = await Promise.all([
      refreshGitHubSessionIfNeeded(fetcher),
      refreshGitHubSessionIfNeeded(fetcher),
    ]);
    expect(outcomes).toEqual(['refreshed', 'refreshed']);
    expect(calls).toHaveLength(1);
  });

  test('signs out when the refresh token is rejected', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now() - 8 * HOUR_MS);
    const { fetcher } = refreshFetcher(
      () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 })
    );
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('signed-out');
    expect(readStoredGitHubToken()).toBe('');
    expect(readStoredGitHubSession()).toBeUndefined();
  });

  test('signs out without a request once the refresh token has expired', async () => {
    const now = Date.now();
    saveGitHubGrantToStorage(
      {
        accessToken: 'ghu_access',
        expiresIn: 1,
        refreshToken: 'ghr_refresh',
        refreshTokenExpiresIn: 1,
      },
      now - 10_000
    );
    const { calls, fetcher } = refreshFetcher(() => Response.json({}));
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('signed-out');
    expect(calls).toHaveLength(0);
    expect(readStoredGitHubToken()).toBe('');
  });

  test('keeps the session on transient failures', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now() - 8 * HOUR_MS);
    const { fetcher } = refreshFetcher(
      () => new Response('down', { status: 502 })
    );
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('failed');
    expect(readStoredGitHubToken()).toBe('ghu_access');
    expect(readStoredGitHubSession()?.refreshToken).toBe('ghr_refresh');

    const thrower: PlainFetch = () => Promise.reject(new Error('offline'));
    expect(await refreshGitHubSessionIfNeeded(thrower)).toBe('failed');
    expect(readStoredGitHubToken()).toBe('ghu_access');
  });
});
