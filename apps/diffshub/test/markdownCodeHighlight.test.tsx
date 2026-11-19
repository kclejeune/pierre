/** @jsxImportSource react */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot } from 'react-dom/client';

import { GitHubEnvironmentProvider } from '../components/GitHubEnvironmentProvider';
import { MarkdownContent } from '../components/MarkdownContent';
import { installJsdomGlobals } from '../lib/test/jsdomGlobals';
import type { GitHubClientEnvironment } from '@/lib/githubEnvironment';
import {
  loadHighlights,
  MAX_HIGHLIGHTED_FENCE_LENGTH,
  tokenizeFence,
  tokenStyle,
} from '@/lib/markdownCodeHighlight';

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

describe('tokenizeFence', () => {
  test('colors tokens with the diff theme custom properties', async () => {
    const highlights = await loadHighlights();
    if (highlights == null) throw new Error('highlights failed to load');
    const lines = tokenizeFence(highlights, 'const x = 1;\nfoo();\n', 'ts');
    expect(lines).toHaveLength(2);
    expect(lines?.[0]?.[0]?.content).toBe('const ');
    expect(lines?.[0]?.[0]?.color).toStartWith('var(--diffs-token-');
  });

  test('leaves unknown languages and oversized fences plain', async () => {
    const highlights = await loadHighlights();
    if (highlights == null) throw new Error('highlights failed to load');
    expect(tokenizeFence(highlights, 'x', 'not-a-language')).toBeNull();
    expect(
      tokenizeFence(
        highlights,
        'a'.repeat(MAX_HIGHLIGHTED_FENCE_LENGTH + 1),
        'ts'
      )
    ).toBeNull();
  });

  test('maps Shiki font-style flags to CSS', () => {
    expect(
      tokenStyle({
        content: 'x',
        offset: 0,
        color: 'red',
        fontStyle: 1 | 2 | 8,
      })
    ).toEqual({
      color: 'red',
      backgroundColor: undefined,
      fontStyle: 'italic',
      fontWeight: 'bold',
      textDecoration: 'line-through',
    });
  });
});

describe('MarkdownContent code fences', () => {
  test('highlights a fence with a language and keeps its text', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const markdown = '```ts\nconst x = 1;\n```\n\n```\nplain\n```\n';
    try {
      await act(async () => {
        root.render(
          <GitHubEnvironmentProvider environment={environment}>
            <MarkdownContent markdown={markdown} />
          </GitHubEnvironmentProvider>
        );
        await loadHighlights();
      });
      const [highlighted, plain] = container.querySelectorAll('pre');
      const code = highlighted?.querySelector('code');
      expect(code?.className).toBe('language-ts');
      expect(code?.textContent).toBe('const x = 1;');
      expect(
        code?.querySelector('span')?.getAttribute('style') ?? ''
      ).toContain('var(--diffs-token-');
      expect(plain?.querySelector('span')).toBeNull();
      expect(plain?.textContent).toBe('plain\n');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
