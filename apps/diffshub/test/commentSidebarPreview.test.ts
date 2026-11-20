import { describe, expect, test } from 'bun:test';

import {
  createCommentSidebarPreview,
  summarizeCommentBody,
} from '@/lib/commentSidebarPreview';

describe('createCommentSidebarPreview', () => {
  test('strips HTML comments and collapses the gap they leave', () => {
    expect(
      createCommentSidebarPreview(
        '<!-- comment-cop:src/file.rs:a0fe2adf9935 -->\n\nFix the code'
      )
    ).toBe('Fix the code');
  });

  test('strips multi-line and mid-body comments', () => {
    expect(
      createCommentSidebarPreview(
        'Before\n\n<!-- first\nsecond -->\n\nAfter <!-- inline --> end'
      )
    ).toBe('Before\n\nAfter  end');
  });

  test('leaves plain markdown untouched', () => {
    expect(createCommentSidebarPreview('Use `<div>` here\n\n- a\n- b')).toBe(
      'Use `<div>` here\n\n- a\n- b'
    );
  });
});

describe('summarizeCommentBody', () => {
  test('takes the first line of text, without markdown', () => {
    expect(
      summarizeCommentBody(
        '## Generate a new release\n\n- [ ] Create mfx/release/2.3.0'
      )
    ).toEqual({ hasMore: true, summary: 'Generate a new release' });
    expect(
      summarizeCommentBody('**Heads up:** see [the docs](https://x.test) `now`')
    ).toEqual({ hasMore: false, summary: 'Heads up: see the docs now' });
  });

  test('skips lines with no text, such as a lone image or tag', () => {
    expect(
      summarizeCommentBody('<img src="a.png">\n\n> Repository scanning found 5')
    ).toEqual({ hasMore: false, summary: 'Repository scanning found 5' });
  });

  test('keeps snake_case and single emphasis marks', () => {
    expect(summarizeCommentBody('set mfx_release to *true*').summary).toBe(
      'set mfx_release to *true*'
    );
  });

  test('a long single line has more to show', () => {
    expect(summarizeCommentBody('word '.repeat(40)).hasMore).toBe(true);
    expect(summarizeCommentBody('')).toEqual({ hasMore: false, summary: '' });
  });
});
