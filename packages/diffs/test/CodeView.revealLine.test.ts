import { afterAll, describe, expect, test } from 'bun:test';
import { createTwoFilesPatch } from 'diff';

import { CodeView } from '../src/components/CodeView';
import { disposeHighlighter } from '../src/highlighter/shared_highlighter';
import type {
  CodeViewItem,
  FileContents,
  FileDiffMetadata,
} from '../src/types';
import { parsePatchFiles } from '../src/utils/parsePatchFiles';
import {
  createRoot,
  installDom,
  renderItems,
  wait,
  waitFor,
} from './domHarness';
import { assertDefined, createDeferred } from './testUtils';

afterAll(async () => {
  await disposeHighlighter();
});

const LINE_COUNT = 40;

// A 40-line file with one changed line near the top, parsed from a
// zero-context patch so everything below the change is outside every hunk.
function createPartialChange(): {
  oldFile: FileContents;
  newFile: FileContents;
  partial: FileDiffMetadata;
} {
  const lines = Array.from(
    { length: LINE_COUNT },
    (_, index) => `line ${index + 1}\n`
  );
  const oldFile: FileContents = {
    name: 'reveal.ts',
    contents: lines.join(''),
    cacheKey: 'reveal:old',
  };
  const newLines = [...lines];
  newLines[1] = 'changed line 2\n';
  const newFile: FileContents = {
    name: oldFile.name,
    contents: newLines.join(''),
    cacheKey: 'reveal:new',
  };
  const partial = parsePatchFiles(
    createTwoFilesPatch(
      oldFile.name,
      newFile.name,
      oldFile.contents,
      newFile.contents,
      undefined,
      undefined,
      { context: 0 }
    ),
    'reveal',
    true
  )[0]?.files[0];
  assertDefined(partial, 'expected patch to contain one partial diff');
  expect(partial.isPartial).toBe(true);
  return { oldFile, newFile, partial };
}

describe('CodeView.revealLine', () => {
  test('hydrates a partial diff and expands the gap holding the line', async () => {
    const { cleanup } = installDom();
    const { oldFile, newFile, partial } = createPartialChange();
    const deferred = createDeferred<{
      oldFile: FileContents;
      newFile: FileContents;
    }>();
    let loadCount = 0;
    const item: CodeViewItem = {
      id: 'diff:reveal.ts',
      type: 'diff',
      fileDiff: partial,
    };
    const viewer = new CodeView({
      disableFileHeader: true,
      loadDiffFiles() {
        loadCount++;
        return deferred.promise;
      },
    });

    try {
      viewer.setup(createRoot());
      await renderItems(viewer, [item]);

      // Lines inside the hunk are renderable without loading anything.
      expect(viewer.revealLine(item.id, 2)).toBe(true);
      expect(loadCount).toBe(0);

      // Line 30 only exists once the full file is loaded.
      expect(viewer.revealLine(item.id, 30)).toBe(false);
      expect(viewer.revealLine(item.id, 30)).toBe(false);
      expect(loadCount).toBe(1);

      deferred.resolve({ oldFile, newFile });
      await waitFor(() => partial.isPartial === false);
      await waitFor(() => viewer.revealLine(item.id, 30));
      expect(loadCount).toBe(1);
    } finally {
      viewer.cleanUp();
      await wait(0);
      cleanup();
    }
  });

  test('reports false for lines it cannot reveal without a loader', async () => {
    const { cleanup } = installDom();
    const { partial } = createPartialChange();
    const item: CodeViewItem = {
      id: 'diff:reveal.ts',
      type: 'diff',
      fileDiff: partial,
    };
    const viewer = new CodeView({ disableFileHeader: true });

    try {
      viewer.setup(createRoot());
      await renderItems(viewer, [item]);
      expect(viewer.revealLine(item.id, 2)).toBe(true);
      expect(viewer.revealLine(item.id, 30)).toBe(false);
      expect(viewer.revealLine('missing', 2)).toBe(false);
    } finally {
      viewer.cleanUp();
      await wait(0);
      cleanup();
    }
  });
});
