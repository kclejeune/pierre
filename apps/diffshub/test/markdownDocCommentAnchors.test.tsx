/** @jsxImportSource react */

import { type DiffLineAnnotation, parseDiffFromFile } from '@pierre/diffs';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { JSDOM } from 'jsdom';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { MarkdownDocAnnotation } from '../components/MarkdownDocAnnotation';
import type { CommentMetadata } from '../lib/types';

const originalGlobals = {
  document: Reflect.get(globalThis, 'document'),
  HTMLElement: Reflect.get(globalThis, 'HTMLElement'),
  IS_REACT_ACT_ENVIRONMENT: Reflect.get(
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean },
    'IS_REACT_ACT_ENVIRONMENT'
  ),
  MutationObserver: Reflect.get(globalThis, 'MutationObserver'),
  window: Reflect.get(globalThis, 'window'),
};

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  pretendToBeVisual: true,
  url: 'http://localhost',
});

beforeAll(() => {
  Object.assign(globalThis, {
    document: dom.window.document,
    HTMLElement: dom.window.HTMLElement,
    MutationObserver: dom.window.MutationObserver,
    window: dom.window,
  });
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterAll(() => {
  for (const [key, value] of Object.entries(originalGlobals)) {
    if (value === undefined) {
      Reflect.deleteProperty(globalThis, key);
    } else {
      Object.assign(globalThis, { [key]: value });
    }
  }
  dom.window.close();
});

// A document shaped like a design doc: headings, paragraphs, and numbered
// lists close together, where a mis-anchored comment is easy to notice.
const NEW_DOC = [
  '## Hello World',
  '',
  'this is a description. it has a couple sentences.',
  '',
  '1. do a thing',
  '2. do another thing',
  '3. do a third thing',
  '',
  'there is a recommendation of doing some other things.',
  '',
  '## Problem',
  '',
  'Some sentence about a problem?',
  'some sentence about another problem?',
  'and another one',
  '',
  '## Plan',
  '',
  '1. do a thing',
  '2. do another thing',
  '3. another one',
  '',
].join('\n');

// The old revision differs inside the first list and the Problem paragraph,
// so the description paragraph at line 3 is unchanged context near changes.
const OLD_DOC = NEW_DOC.replace(
  '1. do a thing\n2. do another thing\n3. do',
  '1. do one thing\n2. do'
).replace('some sentence about another problem?\n', '');

// A minimal saved-comment annotation at the given line; the rail test only
// needs the key and line number, the card body is a test stub.
function savedComment(
  key: string,
  lineNumber: number
): DiffLineAnnotation<CommentMetadata> {
  return {
    side: 'additions',
    lineNumber,
    metadata: {
      kind: 'saved',
      key,
      author: { login: 'tester', avatarUrl: '' },
      message: `message ${key}`,
      range: { start: lineNumber, end: lineNumber, side: 'additions' },
    },
  };
}

interface RenderResult {
  container: HTMLElement;
  clickCommentButton(blockText: string): number | null;
  // The text of the block whose margin rail contains the given comment card.
  blockTextForComment(key: string): string | null;
  unmount(): Promise<void>;
}

async function renderDoc(
  commentAnnotations?: DiffLineAnnotation<CommentMetadata>[]
): Promise<RenderResult> {
  const fileDiff = parseDiffFromFile(
    { name: 'example.md', contents: OLD_DOC },
    { name: 'example.md', contents: NEW_DOC }
  );
  const container = document.createElement('div');
  document.body.append(container);
  const commentedLines: number[] = [];
  let root: Root | undefined;
  await act(async () => {
    root = createRoot(container);
    root.render(
      <MarkdownDocAnnotation
        fileDiff={fileDiff}
        itemId="item"
        commentAnnotations={commentAnnotations}
        renderComment={(annotation) => (
          <span data-comment-key={annotation.metadata.key}>
            card:{annotation.metadata.key}
          </span>
        )}
        onCommentAtLine={(_itemId, line) => {
          commentedLines.push(line);
        }}
      />
    );
    await Promise.resolve();
  });

  return {
    container,
    blockTextForComment(key) {
      const card = container.querySelector(`[data-comment-key="${key}"]`);
      const block = card?.closest('.group\\/mdblock');
      if (block == null) {
        return null;
      }
      return (block.textContent ?? '').replace(/\s+/g, ' ').trim();
    },
    clickCommentButton(blockText) {
      const blocks = Array.from(
        container.querySelectorAll<HTMLElement>('.group\\/mdblock')
      );
      const block = blocks.find((candidate) =>
        (candidate.textContent ?? '').includes(blockText)
      );
      if (block == null) {
        throw new Error(`No rendered block contains: ${blockText}`);
      }
      const button = block.querySelector<HTMLButtonElement>(
        'button[title="Comment on this section"]'
      );
      if (button == null) {
        return null;
      }
      const before = commentedLines.length;
      act(() => {
        button.dispatchEvent(
          new dom.window.MouseEvent('click', { bubbles: true })
        );
      });
      return commentedLines.length > before ? commentedLines.at(-1)! : null;
    },
    async unmount() {
      await act(async () => {
        root?.unmount();
        await Promise.resolve();
      });
      container.remove();
    },
  };
}

describe('MarkdownDocAnnotation comment anchors', () => {
  test('each block anchors comments within its own source range', async () => {
    const rendered = await renderDoc();
    try {
      // The description paragraph is line 3; the changed list right below it
      // must not steal the anchor.
      expect(rendered.clickCommentButton('this is a description')).toBe(3);
      // The first list spans lines 5-7 and contains the changes.
      const listLine = rendered.clickCommentButton('do a third thing');
      expect(listLine).toBeGreaterThanOrEqual(5);
      expect(listLine).toBeLessThanOrEqual(7);
      // The Problem paragraph spans lines 13-15 and contains an added line.
      const problemLine = rendered.clickCommentButton('and another one');
      expect(problemLine).toBeGreaterThanOrEqual(13);
      expect(problemLine).toBeLessThanOrEqual(15);
    } finally {
      await rendered.unmount();
    }
  });

  test('margin-rail comments render beside the block owning their line', async () => {
    const rendered = await renderDoc([
      savedComment('on-heading', 1),
      savedComment('on-description', 3),
      // A blank line between blocks belongs to the block above it.
      savedComment('on-gap', 4),
      savedComment('on-list', 6),
      // Beyond the last block; claimed by the final block.
      savedComment('past-end', 999),
    ]);
    try {
      expect(rendered.blockTextForComment('on-heading')).toContain(
        'Hello World'
      );
      expect(rendered.blockTextForComment('on-description')).toContain(
        'this is a description'
      );
      expect(rendered.blockTextForComment('on-gap')).toContain(
        'this is a description'
      );
      expect(rendered.blockTextForComment('on-list')).toContain(
        'do a third thing'
      );
      expect(rendered.blockTextForComment('past-end')).toContain('another one');
    } finally {
      await rendered.unmount();
    }
  });

  test('rail comments do not shift the comment-anchor mapping', async () => {
    const rendered = await renderDoc([savedComment('on-description', 3)]);
    try {
      expect(rendered.clickCommentButton('this is a description')).toBe(3);
    } finally {
      await rendered.unmount();
    }
  });
});
