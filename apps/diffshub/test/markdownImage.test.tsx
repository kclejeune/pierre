/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { GitHubEnvironmentProvider } from '../components/GitHubEnvironmentProvider';
import { MarkdownImage } from '../components/MarkdownContent';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';
import type { GitHubClientEnvironment } from '@/lib/githubEnvironment';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

const environment: GitHubClientEnvironment = {
  host: 'ghe.example.com',
  isGitHubDotCom: false,
  oauthEnabled: false,
  patInputEnabled: true,
  requireLogin: false,
  tokenEncryptionRequired: false,
  webURL: 'https://ghe.example.com',
};

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

describe('MarkdownImage', () => {
  test('does not carry a failed state to a replacement source', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (src: string) => (
      <GitHubEnvironmentProvider environment={environment}>
        <MarkdownImage src={src} />
      </GitHubEnvironmentProvider>
    );

    try {
      await act(async () => {
        root.render(render('https://ghe.example.com/avatars/u/1'));
        await Promise.resolve();
      });
      act(() => {
        container
          .querySelector('img')
          ?.dispatchEvent(new dom.window.Event('error'));
      });
      expect(container.querySelector('a')).not.toBeNull();

      await act(async () => {
        root.render(render('https://ghe.example.com/avatars/u/2'));
        await Promise.resolve();
      });
      expect(container.querySelector('a')).toBeNull();
      expect(container.querySelector('img')).not.toBeNull();
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
