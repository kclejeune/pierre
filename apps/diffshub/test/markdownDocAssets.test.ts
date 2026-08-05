import { describe, expect, test } from 'bun:test';

import {
  createDocAssetURL,
  resolveDocAssetPath,
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
