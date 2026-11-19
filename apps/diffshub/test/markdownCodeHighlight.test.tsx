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
  CODE_PALETTE_ATTRIBUTE,
  highlightFence,
  installCodePalette,
  loadHighlighter,
  MAX_HIGHLIGHTED_FENCE_LENGTH,
} from '@/lib/markdownCodeHighlight';

const dom = new JSDOM(
  '<!doctype html><html><head></head><body></body></html>',
  {
    pretendToBeVisual: true,
    url: 'http://localhost',
  }
);

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
let highlighter: NonNullable<Awaited<ReturnType<typeof loadHighlighter>>>;

beforeAll(async () => {
  restoreGlobals = installJsdomGlobals({
    CSSStyleRule: dom.window.CSSStyleRule,
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    localStorage: dom.window.localStorage,
    window: dom.window,
  });
  const loaded = await loadHighlighter();
  if (loaded == null) throw new Error('highlights failed to load');
  highlighter = loaded;
});

afterAll(() => {
  restoreGlobals();
  dom.window.close();
});

describe('highlightFence', () => {
  test('colors tokens with the diff theme custom properties', () => {
    const html = highlightFence(highlighter, 'const x = 1;\nfoo();\n', 'ts');
    expect(html).toContain('<span style="color:var(--diffs-token-');
    expect(html).not.toContain('<code');
    expect(html).not.toEndWith('\n');
  });

  test('escapes the source text', () => {
    const html = highlightFence(highlighter, 'x = "<b>&"', 'python') ?? '';
    const code = document.createElement('code');
    code.innerHTML = html;
    expect(code.querySelector('b')).toBeNull();
    expect(code.textContent).toBe('x = "<b>&"');
  });

  test('renders ansi fences as colored text without escape codes', () => {
    const html =
      highlightFence(highlighter, '\x1b[31mred\x1b[0m', 'ansi') ?? '';
    expect(html).toContain('>red<');
    expect(html).not.toContain('\x1b');
  });

  test('highlights unknown languages as plain text', () => {
    const html = highlightFence(highlighter, 'a < b', 'not-a-language') ?? '';
    expect(html).toContain('var(--diffs-token-foreground)');
    expect(html).toContain('a &#x3C; b');
  });

  test('leaves oversized fences plain', () => {
    expect(
      highlightFence(
        highlighter,
        'a'.repeat(MAX_HIGHLIGHTED_FENCE_LENGTH + 1),
        'ts'
      )
    ).toBeNull();
  });
});

describe('installCodePalette', () => {
  test('writes one rule for highlighted blocks and replaces it', () => {
    installCodePalette({ '--diffs-token-keyword': 'red' });
    installCodePalette({ '--diffs-token-keyword': 'blue' });
    const rules = document.head.querySelectorAll(
      '#diffshub-markdown-code-palette'
    );
    expect(rules).toHaveLength(1);
    expect(rules[0]?.textContent).toBe(
      `[${CODE_PALETTE_ATTRIBUTE}] { --diffs-token-keyword: blue; }`
    );
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
        await Promise.resolve();
      });
      const [highlighted, plain] = container.querySelectorAll('pre');
      expect(highlighted?.hasAttribute(CODE_PALETTE_ATTRIBUTE)).toBe(true);
      const code = highlighted?.querySelector('code');
      expect(code?.className).toBe('language-ts');
      expect(code?.textContent).toBe('const x = 1;');
      expect(code?.querySelector('span')).not.toBeNull();
      expect(plain?.hasAttribute(CODE_PALETTE_ATTRIBUTE)).toBe(false);
      expect(plain?.querySelector('span')).toBeNull();
      expect(plain?.textContent).toBe('plain\n');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });

  test('keeps markup inside a raw-HTML code block', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const markdown =
      '<pre><code class="language-js">const <strong>x</strong> = 1;</code></pre>\n';
    try {
      await act(async () => {
        root.render(
          <GitHubEnvironmentProvider environment={environment}>
            <MarkdownContent markdown={markdown} />
          </GitHubEnvironmentProvider>
        );
        await Promise.resolve();
      });
      const pre = container.querySelector('pre');
      expect(pre?.hasAttribute(CODE_PALETTE_ATTRIBUTE)).toBe(false);
      expect(pre?.textContent).toBe('const x = 1;');
      expect(pre?.querySelector('strong')?.textContent).toBe('x');
    } finally {
      act(() => root.unmount());
      container.remove();
    }
  });
});
