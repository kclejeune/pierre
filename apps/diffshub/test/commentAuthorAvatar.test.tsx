/** @jsxImportSource react */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  mock,
  setSystemTime,
  test,
} from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { CommentAuthorAvatar } from '../components/CommentAuthorAvatar';
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

describe('CommentAuthorAvatar', () => {
  test('retries a failed profile lookup after the credential changes', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(() => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response('missing', { status: 404 })
          : Response.json({
              avatarUrl: 'https://cdn.example.com/octocat.png',
              name: 'Octo Cat',
            })
      );
    }) as unknown as typeof fetch;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const author = { avatarUrl: '', login: 'octocat' };

    try {
      saveGitHubTokenToStorage('profile-token-1');
      await act(async () => {
        root.render(<CommentAuthorAvatar author={author} />);
        await Promise.resolve();
      });
      expect(container.textContent).toBe('O');

      await act(async () => {
        saveGitHubTokenToStorage('profile-token-2');
        await Promise.resolve();
      });
      expect(calls).toBe(2);
      expect(container.querySelector('img')?.src).toBe(
        'https://cdn.example.com/octocat.png'
      );
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
    }
  });

  test('retries a failed avatar URL after the credential changes', async () => {
    const originalFetch = globalThis.fetch;
    // The failure-path profile lookup; resolving to a miss keeps the
    // component on the initials fallback until the credential changes.
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('missing', { status: 404 }))
    ) as unknown as typeof fetch;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const author = {
      avatarUrl: 'https://example.com/avatars/octocat.png',
      login: 'octocat',
    };

    try {
      saveGitHubTokenToStorage('first-token');
      await act(async () => {
        root.render(<CommentAuthorAvatar author={author} />);
        await Promise.resolve();
      });
      const img = container.querySelector('img');
      expect(img?.src).toBe(author.avatarUrl);

      // A load failure (mid-rotation 401, expired signed URL) records the URL
      // as dead and falls back to initials.
      await act(async () => {
        img?.dispatchEvent(new dom.window.Event('error'));
        await Promise.resolve();
      });
      expect(container.querySelector('img')).toBeNull();
      expect(container.textContent).toBe('O');

      // A credential change clears the failure record so the avatar is tried
      // again instead of showing initials forever.
      await act(async () => {
        saveGitHubTokenToStorage('second-token');
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe(author.avatarUrl);
    } finally {
      act(() => root.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
    }
  });

  test('retries a failed avatar URL after the failure record expires', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response('missing', { status: 404 }))
    ) as unknown as typeof fetch;

    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const author = {
      avatarUrl: 'https://example.com/avatars/hubot.png',
      login: 'hubot',
    };

    try {
      setSystemTime(new Date('2026-08-31T12:00:00Z'));
      await act(async () => {
        root.render(<CommentAuthorAvatar author={author} />);
        await Promise.resolve();
      });
      await act(async () => {
        container
          .querySelector('img')
          ?.dispatchEvent(new dom.window.Event('error'));
        await Promise.resolve();
      });
      expect(container.querySelector('img')).toBeNull();

      // A transient failure (CDN 429, network blip) is remembered briefly;
      // a render after the TTL retries the URL instead of pinning initials
      // for the rest of the session.
      setSystemTime(new Date('2026-08-31T12:00:31Z'));
      await act(async () => {
        root.render(<CommentAuthorAvatar author={author} />);
        await Promise.resolve();
      });
      expect(container.querySelector('img')?.src).toBe(author.avatarUrl);
    } finally {
      setSystemTime();
      act(() => root.unmount());
      container.remove();
      globalThis.fetch = originalFetch;
    }
  });
});
