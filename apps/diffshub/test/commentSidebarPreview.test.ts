import { describe, expect, test } from 'bun:test';

import { createCommentSidebarPreview } from '@/lib/commentSidebarPreview';

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
