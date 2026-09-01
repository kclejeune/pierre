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

  test('keeps the replacement request cached after a superseded request fails', async () => {
    const requests: Array<{
      reject(error: Error): void;
      resolve(response: Response): void;
    }> = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    globalThis.fetch = mock(
      () =>
        new Promise<Response>((resolve, reject) => {
          requests.push({ reject, resolve });
        })
    ) as unknown as typeof fetch;
    URL.createObjectURL = mock(() => 'blob:replacement');

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
        requests[0]?.reject(new Error('stale credential'));
        await Promise.resolve();
        root.render(<GitHubAssetImage key="remounted" src={src} />);
        await Promise.resolve();
      });
      expect(requests).toHaveLength(2);

      await act(async () => {
        requests[1]?.resolve(new Response('image', { status: 200 }));
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe('blob:replacement');
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
    }
  });
});
