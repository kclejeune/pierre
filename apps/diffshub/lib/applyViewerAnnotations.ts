import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';

import { incrementItemVersion } from './incrementItemVersion';
import { isDiffItem } from './isDiffItem';
import type { CommentMetadata } from './types';

interface ApplyViewerAnnotationsOptions<
  Entry,
  Metadata extends CommentMetadata,
> {
  createAnnotation(entry: Entry): DiffLineAnnotation<Metadata>;
  // Annotation identity within an item: entries whose key is already present
  // on the item are skipped, so re-application is idempotent.
  getKey(entry: Entry): string;
  getPath(entry: Entry): string;
  // Fired once per injected annotation after the item accepts the update.
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
// item already has, and reports every injected annotation via onApplied.
// Entries whose path is absent from the diff are skipped.
export function applyViewerAnnotations<Entry, Metadata extends CommentMetadata>(
  viewer: CodeViewHandle<CommentMetadata>,
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
    const existingKeys = new Set(
      annotations.map((annotation) => annotation.metadata.key)
    );
    const fresh = itemEntries
      .filter((entry) => !existingKeys.has(options.getKey(entry)))
      .map((entry) => ({ annotation: options.createAnnotation(entry), entry }));
    if (fresh.length === 0) {
      continue;
    }
    // The upcast to the metadata union is safe (Metadata extends
    // CommentMetadata) but unprovable to TS: DiffLineAnnotation wraps its
    // parameter in a distributive conditional that an unresolved generic
    // cannot flow through.
    item.annotations = [
      ...annotations,
      ...fresh.map((f) => f.annotation as DiffLineAnnotation<CommentMetadata>),
    ];
    incrementItemVersion(item);
    if (!viewer.updateItem(item)) {
      continue;
    }
    for (const { annotation, entry } of fresh) {
      options.onApplied(item.fileDiff, itemId, entry, annotation);
    }
  }
}
