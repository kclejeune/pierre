import { describe, expect, test } from 'bun:test';

import {
  createDocAssetURL,
  resolveDocAssetPath,
  resolveDocLinkTarget,
} from '../lib/markdownDocAssets';

describe('resolveDocAssetPath', () => {
  test('resolves sibling and nested references against the doc directory', () => {
    expect(resolveDocAssetPath('logo.png', 'docs/guide/intro.md')).toBe(
      'docs/guide/logo.png'
    );
    expect(resolveDocAssetPath('./images/a.png', 'docs/guide/intro.md')).toBe(
      'docs/guide/images/a.png'
    );
    expect(resolveDocAssetPath('images/a.png', 'README.md')).toBe(
      'images/a.png'
    );
  });

  test('collapses parent segments without escaping the repository', () => {
    expect(resolveDocAssetPath('../shared/b.png', 'docs/guide/intro.md')).toBe(
      'docs/shared/b.png'
    );
    expect(resolveDocAssetPath('../../../../x.png', 'docs/intro.md')).toBe(
      'x.png'
    );
  });

  test('treats a leading slash as the repository root', () => {
    expect(resolveDocAssetPath('/assets/images/c.png', 'docs/intro.md')).toBe(
      'assets/images/c.png'
    );
  });

  test('decodes percent-encoded path segments', () => {
    expect(resolveDocAssetPath('my%20image.png', 'docs/intro.md')).toBe(
      'docs/my image.png'
    );
  });

  test('leaves absolute and non-file references alone', () => {
    expect(
      resolveDocAssetPath('https://example.com/a.png', 'docs/intro.md')
    ).toBeNull();
    expect(
      resolveDocAssetPath('data:image/png;base64,x', 'docs/intro.md')
    ).toBeNull();
    expect(
      resolveDocAssetPath('//cdn.example.com/a.png', 'docs/intro.md')
    ).toBeNull();
    expect(resolveDocAssetPath('#section', 'docs/intro.md')).toBeNull();
    expect(resolveDocAssetPath('', 'docs/intro.md')).toBeNull();
  });
});

describe('resolveDocLinkTarget', () => {
  const WEB_URL = 'https://github.example.com';

  test('points pull-source links at the refs/pull head ref', () => {
    expect(
      resolveDocLinkTarget(
        './guide.md',
        'docs/README.md',
        'octo/demo/pull/41',
        WEB_URL
      )
    ).toEqual({
      path: 'docs/guide.md',
      url: 'https://github.example.com/octo/demo/blob/refs/pull/41/head/docs/guide.md',
    });
  });

  test('keeps the fragment and resolves parent segments', () => {
    expect(
      resolveDocLinkTarget(
        '../CONTRIBUTING.md#setup',
        'docs/README.md',
        'octo/demo/pull/41',
        WEB_URL
      )
    ).toEqual({
      path: 'CONTRIBUTING.md',
      url: 'https://github.example.com/octo/demo/blob/refs/pull/41/head/CONTRIBUTING.md#setup',
    });
  });

  test('uses the sha for commit sources and the head for compares', () => {
    expect(
      resolveDocLinkTarget(
        'a.md',
        'README.md',
        'octo/demo/commit/abc123',
        WEB_URL
      )
    ).toEqual({
      path: 'a.md',
      url: 'https://github.example.com/octo/demo/blob/abc123/a.md',
    });
    expect(
      resolveDocLinkTarget(
        'a.md',
        'README.md',
        'octo/demo/compare/main...feat/thing',
        WEB_URL
      )
    ).toEqual({
      path: 'a.md',
      url: 'https://github.example.com/octo/demo/blob/feat/thing/a.md',
    });
  });

  test('leaves fork compare heads, absolute URLs, and anchors alone', () => {
    expect(
      resolveDocLinkTarget(
        'a.md',
        'README.md',
        'octo/demo/compare/main...fork:branch',
        WEB_URL
      )
    ).toBeNull();
    expect(
      resolveDocLinkTarget(
        'https://example.com/a',
        'README.md',
        'octo/demo/pull/41',
        WEB_URL
      )
    ).toBeNull();
    expect(
      resolveDocLinkTarget('#usage', 'README.md', 'octo/demo/pull/41', WEB_URL)
    ).toBeNull();
    expect(
      resolveDocLinkTarget(
        'mailto:dev@example.com',
        'README.md',
        'octo/demo/pull/41',
        WEB_URL
      )
    ).toBeNull();
  });

  test('encodes path segments without encoding separators', () => {
    expect(
      resolveDocLinkTarget(
        './release notes.md',
        'docs/README.md',
        'octo/demo/pull/41',
        WEB_URL
      )
    ).toEqual({
      path: 'docs/release notes.md',
      url: 'https://github.example.com/octo/demo/blob/refs/pull/41/head/docs/release%20notes.md',
    });
  });
});

describe('createDocAssetURL', () => {
  test('encodes the source path and file, marking only the old side', () => {
    expect(
      createDocAssetURL('oven-sh/bun/pull/30412', 'docs/img/a b.png', 'new')
    ).toBe(
      '/api/github-doc-asset?file=docs%2Fimg%2Fa+b.png&path=oven-sh%2Fbun%2Fpull%2F30412'
    );
    expect(createDocAssetURL('o/r/commit/abc', 'a.png', 'old')).toBe(
      '/api/github-doc-asset?file=a.png&path=o%2Fr%2Fcommit%2Fabc&side=old'
    );
  });
});
