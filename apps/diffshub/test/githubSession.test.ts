import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  consumeReauthIntent,
  getGitHubTokenSnapshot,
  GITHUB_TOKEN_CHANGE_EVENT,
  githubFetch,
  isStoredGitHubTokenExpired,
  nextGitHubRefreshDueAt,
  readStoredGitHubSession,
  readStoredGitHubToken,
  refreshGitHubSessionIfNeeded,
  reportGitHubAuthFailure,
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

// A fetch stub that stays pending until the test answers it, for exercising
// what happens when storage changes while a refresh is in flight.
function deferredFetcher(): {
  answer: (response: Response) => void;
  fetcher: PlainFetch;
} {
  let answer: (response: Response) => void = () => undefined;
  const fetcher: PlainFetch = () =>
    new Promise<Response>((resolve) => {
      answer = resolve;
    });
  return { answer: (response) => answer(response), fetcher };
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

  test('a forced refresh follows a queued proactive check that does no work', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { calls, fetcher } = refreshFetcher(() =>
      Response.json({ access_token: 'ghu_next', refresh_token: 'ghr_next' })
    );
    const originalNavigator = Object.getOwnPropertyDescriptor(
      globalThis,
      'navigator'
    );
    let releaseFirstLock = () => undefined;
    let lockRequests = 0;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        locks: {
          request<T>(_name: string, operation: () => Promise<T>): Promise<T> {
            lockRequests += 1;
            if (lockRequests > 1) {
              return operation();
            }
            return new Promise<T>((resolve, reject) => {
              releaseFirstLock = () => {
                void operation().then(resolve, reject);
              };
            });
          },
        },
      },
    });

    try {
      const proactive = refreshGitHubSessionIfNeeded(fetcher);
      const forced = refreshGitHubSessionIfNeeded(fetcher, true);
      expect(calls).toHaveLength(0);
      releaseFirstLock();
      expect(await proactive).toBe('fresh');
      expect(await forced).toBe('refreshed');
      expect(calls).toHaveLength(1);
    } finally {
      if (originalNavigator == null) {
        Reflect.deleteProperty(globalThis, 'navigator');
      } else {
        Object.defineProperty(globalThis, 'navigator', originalNavigator);
      }
    }
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

  // A deployment with DIFFSHUB_REFRESH_TOKEN_MAX_TTL=0 issues expiring grants
  // with no refresh token; the client must clear the dead token at expiry so
  // the sign-in prompt surfaces instead of a wall of 401s.
  test('signs out an expiring grant with no refresh token once it expires', async () => {
    const now = Date.now();
    saveGitHubGrantToStorage(
      { accessToken: 'ghu_access', expiresIn: 8 * 3600 },
      now - 9 * HOUR_MS
    );
    expect(nextGitHubRefreshDueAt()).toBe(now - 9 * HOUR_MS + 8 * HOUR_MS);
    const { calls, fetcher } = refreshFetcher(() => Response.json({}));
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('signed-out');
    expect(calls).toHaveLength(0);
    expect(readStoredGitHubToken()).toBe('');
  });

  test('leaves an unexpired refresh-token-less grant alone', async () => {
    saveGitHubGrantToStorage(
      { accessToken: 'ghu_access', expiresIn: 8 * 3600 },
      Date.now()
    );
    const { calls, fetcher } = refreshFetcher(() => Response.json({}));
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('none');
    expect(calls).toHaveLength(0);
    expect(readStoredGitHubToken()).toBe('ghu_access');
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

describe('re-auth intent and auth-failure reporting', () => {
  const GRANT_RESPONSE = Response.json({
    access_token: 'ghu_next',
    expires_in: 8 * 3600,
    refresh_token: 'ghr_next',
    refresh_token_expires_in: 183 * 24 * 3600,
  });

  test('a rejected refresh stamps re-auth intent alongside the sign-out', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now() - 9 * HOUR_MS);
    const { fetcher } = refreshFetcher(
      () => new Response('{}', { status: 401 })
    );
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('signed-out');
    expect(readStoredGitHubToken()).toBe('');
    expect(consumeReauthIntent()).toBe(true);
    // The stamp is consumed exactly once.
    expect(consumeReauthIntent()).toBe(false);
  });

  test('force refreshes a token that is nowhere near expiring', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { calls, fetcher } = refreshFetcher(() => GRANT_RESPONSE.clone());
    expect(await refreshGitHubSessionIfNeeded(fetcher)).toBe('fresh');
    expect(calls.length).toBe(0);
    expect(await refreshGitHubSessionIfNeeded(fetcher, true)).toBe('refreshed');
    expect(calls.length).toBe(1);
    expect(readStoredGitHubToken()).toBe('ghu_next');
  });

  test('a 401 with a refreshable session forces a refresh instead of signing out', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { calls, fetcher } = refreshFetcher(() => GRANT_RESPONSE.clone());
    await reportGitHubAuthFailure({ status: 401 }, 'ghu_access', fetcher);
    expect(calls.length).toBe(1);
    expect(consumeReauthIntent()).toBe(false);

    // A straggler tied to the old token cannot rotate the replacement again.
    await reportGitHubAuthFailure({ status: 401 }, 'ghu_access', fetcher);
    expect(calls.length).toBe(1);
  });

  test('a 401 with an unrefreshable credential signs out with re-auth intent', async () => {
    saveGitHubTokenToStorage('ghp_revoked_pat');
    await reportGitHubAuthFailure({ status: 401 }, 'ghp_revoked_pat');
    expect(readStoredGitHubToken()).toBe('');
    expect(consumeReauthIntent()).toBe(true);
  });

  test('a stale 401 cannot clear a replacement credential', async () => {
    saveGitHubTokenToStorage('ghp_old');
    saveGitHubTokenToStorage('ghp_replacement');
    expect(await reportGitHubAuthFailure({ status: 401 }, 'ghp_old')).toBe(
      'ghp_replacement'
    );
    expect(readStoredGitHubToken()).toBe('ghp_replacement');
    expect(consumeReauthIntent()).toBe(false);
  });

  test('a late refresh response cannot overwrite a replacement credential', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { answer, fetcher } = deferredFetcher();
    const refresh = refreshGitHubSessionIfNeeded(fetcher, true, 'ghu_access');
    await Promise.resolve();
    saveGitHubTokenToStorage('ghp_replacement');
    answer(GRANT_RESPONSE.clone());

    expect(await refresh).toBe('fresh');
    expect(readStoredGitHubToken()).toBe('ghp_replacement');
  });

  test('a late rejected refresh cannot clear a session rotated elsewhere', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const { answer, fetcher } = deferredFetcher();
    const refresh = refreshGitHubSessionIfNeeded(fetcher, true, 'ghu_access');
    await Promise.resolve();
    saveGitHubGrantToStorage({
      // The refresh token is the generation marker even if an upstream ever
      // reuses the access-token string.
      accessToken: 'ghu_access',
      refreshToken: 'ghr_rotated',
    });
    answer(new Response('{}', { status: 401 }));

    expect(await refresh).toBe('fresh');
    expect(readStoredGitHubToken()).toBe('ghu_access');
    expect(readStoredGitHubSession()?.refreshToken).toBe('ghr_rotated');
  });

  test('githubFetch refreshes and retries an authenticated GET once', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    const calls: Array<{ authorization: string | null; url: string }> = [];
    let firstResourceAttempt = true;
    const fetcher: PlainFetch = (input, init) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      calls.push({
        authorization: new Headers(init?.headers).get('authorization'),
        url,
      });
      if (url === '/api/auth/github/refresh') {
        return Promise.resolve(GRANT_RESPONSE.clone());
      }
      if (firstResourceAttempt) {
        firstResourceAttempt = false;
        return Promise.resolve(new Response('{}', { status: 401 }));
      }
      return Promise.resolve(Response.json({ ok: true }));
    };

    const response = await githubFetch(
      '/resource',
      { headers: { authorization: 'Bearer ghu_access' } },
      fetcher
    );
    expect(response.status).toBe(200);
    expect(calls).toEqual([
      { authorization: 'Bearer ghu_access', url: '/resource' },
      { authorization: null, url: '/api/auth/github/refresh' },
      { authorization: 'Bearer ghu_next', url: '/resource' },
    ]);
  });

  // A Request input carries its own headers and method; githubFetch must read
  // both from the Request, not only from init, or it clobbers a caller's auth
  // and misjudges a mutating request as a retryable GET.
  test('githubFetch honors a Request input over the stored token', async () => {
    saveGitHubTokenToStorage('ghp_stored');
    const seen: Array<string | null> = [];
    const fetcher: PlainFetch = (_input, init) => {
      seen.push(new Headers(init?.headers).get('authorization'));
      return Promise.resolve(Response.json({ ok: true }));
    };

    await githubFetch(
      new Request('https://diffs.example.com/resource', {
        headers: { authorization: 'Bearer ghp_request' },
      }),
      undefined,
      fetcher
    );
    expect(seen).toEqual(['Bearer ghp_request']);
  });

  test('githubFetch lets init headers replace Request headers', async () => {
    saveGitHubTokenToStorage('ghp_stored');
    const seen: Array<Record<string, string>> = [];
    const fetcher: PlainFetch = (_input, init) => {
      seen.push(Object.fromEntries(new Headers(init?.headers)));
      return Promise.resolve(Response.json({ ok: true }));
    };

    await githubFetch(
      new Request('https://diffs.example.com/resource', {
        headers: {
          authorization: 'Bearer ghp_request',
          'x-request': 'request',
        },
      }),
      { headers: { 'x-init': 'init' } },
      fetcher
    );
    expect(seen).toEqual([
      { authorization: 'Bearer ghp_stored', 'x-init': 'init' },
    ]);
  });

  test('githubFetch does not retry a Request-carried POST after a 401', async () => {
    saveGitHubGrantToStorage(EXPIRING_GRANT, Date.now());
    let attempts = 0;
    const fetcher: PlainFetch = (input) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (url === '/api/auth/github/refresh') {
        return Promise.resolve(GRANT_RESPONSE.clone());
      }
      attempts += 1;
      return Promise.resolve(new Response('{}', { status: 401 }));
    };

    const response = await githubFetch(
      new Request('https://diffs.example.com/resource', { method: 'POST' }),
      undefined,
      fetcher
    );
    expect(response.status).toBe(401);
    expect(attempts).toBe(1);
  });

  // Consuming enforces the one-automatic-hop window itself, so a second
  // credential death moments after an auto-forward falls back to the form.
  test('consumption enforces the auto-reauth window', async () => {
    const start = 1_000_000_000;
    saveGitHubTokenToStorage('ghp_dead');
    await reportGitHubAuthFailure({ status: 401 }, 'ghp_dead');
    expect(consumeReauthIntent(start)).toBe(true);

    saveGitHubTokenToStorage('ghp_dead_again');
    await reportGitHubAuthFailure({ status: 401 }, 'ghp_dead_again');
    expect(consumeReauthIntent(start + 30_000)).toBe(false);

    saveGitHubTokenToStorage('ghp_dead_later');
    await reportGitHubAuthFailure({ status: 401 }, 'ghp_dead_later');
    expect(consumeReauthIntent(start + 90_000)).toBe(true);
  });

  test('ignores non-401 responses and tokenless 401s', async () => {
    saveGitHubTokenToStorage('ghp_pat');
    await reportGitHubAuthFailure({ status: 403 }, 'ghp_pat');
    expect(readStoredGitHubToken()).toBe('ghp_pat');

    saveGitHubTokenToStorage('');
    await reportGitHubAuthFailure({ status: 401 }, '');
    expect(consumeReauthIntent()).toBe(false);
  });
});
