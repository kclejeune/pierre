/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { GitHubAssetImage } from '../components/GitHubAssetImage';
import { saveGitHubTokenToStorage } from '../components/githubSession';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

let restoreGlobals: () => void;

beforeAll(() => {
  restoreGlobals = installJsdomGlobals({
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
});

afterAll(() => {
  restoreGlobals();
  dom.window.close();
});

describe('GitHubAssetImage', () => {
  test('refetches an authenticated asset when the credential changes', async () => {
    const authorizations: string[] = [];
    const revoked: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    globalThis.fetch = mock((_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      authorizations.push(authorization ?? '');
      return Promise.resolve(new Response('image', { status: 200 }));
    }) as unknown as typeof fetch;
    URL.createObjectURL = mock(() => `blob:avatar-${authorizations.length}`);
    URL.revokeObjectURL = mock((url) => revoked.push(url));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      saveGitHubTokenToStorage('first-token');
      await act(async () => {
        root.render(
          <GitHubAssetImage src="/api/github-web-asset?url=avatar" />
        );
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:avatar-1');

      await act(async () => {
        saveGitHubTokenToStorage('second-token');
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:avatar-2');
      expect(authorizations).toEqual([
        'Bearer first-token',
        'Bearer second-token',
      ]);
      expect(revoked).toEqual(['blob:avatar-1']);

      await act(async () => {
        saveGitHubTokenToStorage('');
        await Promise.resolve();
      });
      expect(revoked).toEqual(['blob:avatar-1', 'blob:avatar-2']);
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test('revokes an object URL resolved after its credential was superseded', async () => {
    const requests: Array<{
      resolve(response: Response): void;
    }> = [];
    const revoked: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve) => {
          requests.push({ resolve });
        })
    ) as unknown as typeof fetch;
    let created = 0;
    URL.createObjectURL = mock(() => `blob:avatar-${++created}`);
    URL.revokeObjectURL = mock((url) => revoked.push(url));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const src = '/api/github-web-asset?url=late-failure-avatar';

    try {
      saveGitHubTokenToStorage('stale-token');
      await act(async () => {
        root.render(<GitHubAssetImage src={src} />);
        await Promise.resolve();
      });
      expect(requests).toHaveLength(1);

      await act(async () => {
        saveGitHubTokenToStorage('replacement-token');
        await Promise.resolve();
      });
      expect(requests).toHaveLength(2);

      await act(async () => {
        requests[0]?.resolve(new Response('stale image', { status: 200 }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(revoked).toEqual(['blob:avatar-1']);
      expect(container.querySelector('img')?.src).not.toBe('blob:avatar-1');

      await act(async () => {
        requests[1]?.resolve(new Response('image', { status: 200 }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:avatar-2');
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test('stops rendering a revoked blob while the replacement is in flight', async () => {
    const pending: Array<(response: Response) => void> = [];
    const revoked: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let requestCount = 0;
    globalThis.fetch = mock(() => {
      requestCount += 1;
      // The first credential resolves immediately; the replacement is held open
      // so the window between revoking the old blob and resolving the new one
      // is observable.
      return requestCount === 1
        ? Promise.resolve(new Response('image', { status: 200 }))
        : new Promise<Response>((resolve) => pending.push(resolve));
    }) as unknown as typeof fetch;
    let created = 0;
    URL.createObjectURL = mock(() => `blob:avatar-${++created}`);
    URL.revokeObjectURL = mock((url) => revoked.push(url));

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);

    try {
      saveGitHubTokenToStorage('first-token');
      await act(async () => {
        root.render(<GitHubAssetImage src="/api/github-web-asset?url=a" />);
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:avatar-1');

      await act(async () => {
        saveGitHubTokenToStorage('second-token');
        await Promise.resolve();
      });

      // blob:avatar-1 was revoked by the effect cleanup, so pointing <img> at
      // it would render a broken image (or the previous viewer's avatar).
      expect(revoked).toEqual(['blob:avatar-1']);
      expect(container.querySelector('img')?.getAttribute('src')).toBeNull();

      await act(async () => {
        pending[0]?.(new Response('image', { status: 200 }));
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:avatar-2');
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test('shares one authorized fetch across concurrent mounts of the same asset', async () => {
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    let fetchCount = 0;
    globalThis.fetch = mock(() => {
      fetchCount += 1;
      return Promise.resolve(new Response('image', { status: 200 }));
    }) as unknown as typeof fetch;
    let created = 0;
    URL.createObjectURL = mock(() => `blob:avatar-${++created}`);
    URL.revokeObjectURL = mock(() => undefined);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    // The same author's avatar, as a comment thread renders it on every row.
    const src = '/api/github-web-asset?url=shared-avatar';

    try {
      saveGitHubTokenToStorage('first-token');
      await act(async () => {
        root.render(
          <>
            <GitHubAssetImage src={src} />
            <GitHubAssetImage src={src} />
            <GitHubAssetImage src={src} />
          </>
        );
        await Promise.resolve();
      });

      // One request for three mounts, but each mount owns its own object URL so
      // unmounting one cannot revoke a blob another is still rendering.
      expect(fetchCount).toBe(1);
      const images = [...container.querySelectorAll('img')];
      expect(images).toHaveLength(3);
      expect(new Set(images.map((image) => image.src)).size).toBe(3);
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });

  test('does not share an in-flight fetch across credentials', async () => {
    const authorizations: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    globalThis.fetch = mock((_input, init) => {
      authorizations.push(
        new Headers(init?.headers).get('authorization') ?? ''
      );
      return Promise.resolve(new Response('image', { status: 200 }));
    }) as unknown as typeof fetch;
    let created = 0;
    URL.createObjectURL = mock(() => `blob:avatar-${++created}`);
    URL.revokeObjectURL = mock(() => undefined);

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const src = '/api/github-web-asset?url=per-credential-avatar';

    try {
      saveGitHubTokenToStorage('first-token');
      await act(async () => {
        root.render(
          <>
            <GitHubAssetImage src={src} />
            <GitHubAssetImage src={src} />
          </>
        );
        await Promise.resolve();
      });
      expect(authorizations).toEqual(['Bearer first-token']);

      await act(async () => {
        saveGitHubTokenToStorage('second-token');
        await Promise.resolve();
      });

      // Both mounts refetch under the new credential, sharing that request with
      // each other rather than reusing the previous credential's result.
      expect(authorizations).toEqual([
        'Bearer first-token',
        'Bearer second-token',
      ]);
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
