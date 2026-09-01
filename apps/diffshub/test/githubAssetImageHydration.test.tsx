/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { hydrateRoot } from 'react-dom/client';
import { renderToString } from 'react-dom/server';

import { GitHubAssetImage } from '../components/GitHubAssetImage';
import { GitHubEnvironmentProvider } from '../components/GitHubEnvironmentProvider';
import { saveGitHubTokenToStorage } from '../components/githubSession';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';
import type { GitHubClientEnvironment } from '@/lib/githubEnvironment';

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

// A require-login deployment: a tokenless resolve yields the unloadable
// data: sentinel, which fires onError on consumers that record the failure.
const REQUIRE_LOGIN_ENVIRONMENT: GitHubClientEnvironment = {
  host: 'github.example.com',
  isGitHubDotCom: false,
  oauthEnabled: true,
  patInputEnabled: false,
  requireLogin: true,
  tokenEncryptionRequired: true,
  webURL: 'https://github.example.com',
};

describe('GitHubAssetImage hydration', () => {
  test('first fetch after hydration carries the stored token', async () => {
    const authorizations: string[] = [];
    const srcAssignments: string[] = [];
    const originalFetch = globalThis.fetch;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalSetAttribute = dom.window.Element.prototype.setAttribute;
    globalThis.fetch = mock((_input, init) => {
      const authorization = new Headers(init?.headers).get('authorization');
      authorizations.push(authorization ?? '');
      return Promise.resolve(new Response('image', { status: 200 }));
    }) as unknown as typeof fetch;
    URL.createObjectURL = mock(() => `blob:hydrated-${authorizations.length}`);
    dom.window.Element.prototype.setAttribute = function (
      name: string,
      value: string
    ) {
      if (this.tagName === 'IMG' && name === 'src') {
        srcAssignments.push(value);
      }
      originalSetAttribute.call(this, name, value);
    };

    const element = (
      <GitHubEnvironmentProvider environment={REQUIRE_LOGIN_ENVIRONMENT}>
        <GitHubAssetImage src="/api/github-web-asset?url=hydrated-avatar" />
      </GitHubEnvironmentProvider>
    );
    const container = document.createElement('div');
    document.body.append(container);
    container.innerHTML = renderToString(element);

    let root: ReturnType<typeof hydrateRoot> | undefined;
    try {
      saveGitHubTokenToStorage('stored-token');
      await act(async () => {
        root = hydrateRoot(container, element);
        await Promise.resolve();
      });

      // The store reports the tokenless server snapshot during hydration; the
      // effect must still resolve with the stored token, never the unloadable
      // sentinel that would fire onError and poison consumer failure caches.
      expect(srcAssignments).not.toContain('data:,');
      expect(authorizations).toEqual(['Bearer stored-token']);
      expect(container.querySelector('img')?.src).toBe('blob:hydrated-1');
    } finally {
      act(() => root?.unmount());
      container.remove();
      saveGitHubTokenToStorage('');
      globalThis.fetch = originalFetch;
      URL.createObjectURL = originalCreateObjectURL;
      dom.window.Element.prototype.setAttribute = originalSetAttribute;
    }
  });
});
