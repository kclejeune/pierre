import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';

import { incrementItemVersion } from './incrementItemVersion';
import { isDiffItem } from './isDiffItem';
import type { CommentMetadata } from './types';

interface ApplyViewerAnnotationsOptions<
  Entry,
  Metadata extends CommentMetadata,
> {
  // `fileDiff` is the entry's file, for annotations whose side depends on it.
  createAnnotation(
    entry: Entry,
    fileDiff: FileDiffMetadata
  ): DiffLineAnnotation<Metadata>;
  // Annotation identity within an item: entries whose key is already present
  // on the item are skipped, so re-application is idempotent.
  getKey(entry: Entry): string;
  getPath(entry: Entry): string;
  // Whether an annotation already on the item under the entry's key shows
  // outdated content and should be replaced by a fresh one. Without it,
  // present annotations are always kept.
  isStale?(
    entry: Entry,
    annotation: DiffLineAnnotation<CommentMetadata>
  ): boolean;
  // Fired once per injected or replaced annotation after the item accepts
  // the update.
  onApplied(
    fileDiff: FileDiffMetadata,
    itemId: string,
    entry: Entry,
    annotation: DiffLineAnnotation<Metadata>
  ): void;
}

// Shared injection step for annotation sources that re-apply once per viewer
// generation (review threads, pending review cards): resolves each entry's
// item by file path, batches per file so each updateItem call — a synchronous
// layout/render pass — happens once per item, dedupes against annotations the
// item already has (replacing ones `isStale` flags), and reports every
// injected annotation via onApplied.
// Entries whose path is absent from the diff are skipped.
export function applyViewerAnnotations<Entry, Metadata extends CommentMetadata>(
  viewer: CodeViewHandle<CommentMetadata, undefined>,
  pathToItemId: ReadonlyMap<string, string>,
  entries: Iterable<Entry>,
  options: ApplyViewerAnnotationsOptions<Entry, Metadata>
): void {
  const entriesByItemId = new Map<string, Entry[]>();
  for (const entry of entries) {
    const itemId = pathToItemId.get(options.getPath(entry));
    if (itemId == null) {
      continue;
    }
    const itemEntries = entriesByItemId.get(itemId);
    if (itemEntries == null) {
      entriesByItemId.set(itemId, [entry]);
    } else {
      itemEntries.push(entry);
    }
  }

  for (const [itemId, itemEntries] of entriesByItemId) {
    const item = viewer.getItem(itemId);
    if (item == null || !isDiffItem(item)) {
      continue;
    }
    const annotations = item.annotations ?? [];
    const existingByKey = new Map(
      annotations.map((annotation) => [annotation.metadata.key, annotation])
    );
    // Keys are unique per item; a Map keeps replacements in place and
    // appends new keys.
    const next = new Map<string, DiffLineAnnotation<CommentMetadata>>(
      existingByKey
    );
    const fresh: {
      annotation: DiffLineAnnotation<Metadata>;
      entry: Entry;
    }[] = [];
    for (const entry of itemEntries) {
      const key = options.getKey(entry);
      const existing = existingByKey.get(key);
      if (existing != null && options.isStale?.(entry, existing) !== true) {
        continue;
      }
      const annotation = options.createAnnotation(entry, item.fileDiff);
      fresh.push({ annotation, entry });
      next.set(key, annotation);
    }
    if (fresh.length === 0) {
      continue;
    }
    item.annotations = [...next.values()];
    incrementItemVersion(item);
    if (!viewer.updateItem(item)) {
      continue;
    }
    for (const { annotation, entry } of fresh) {
      options.onApplied(item.fileDiff, itemId, entry, annotation);
    }
  }
}
