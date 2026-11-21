import { createCommentSidebarPreview } from './commentSidebarPreview';
import { createPullReviewThread, toAnnotationSide } from './pullReviewThreads';
import { uniqueCommentAuthors } from './savedCommentEvent';
import type {
  DiffsHubCommentFileByItemId,
  DiffsHubSavedCommentEntry,
  DiffsHubSavedCommentItem,
  PullReviewComment,
  PullReviewThreadState,
} from './types';

// The Comments list's sections for review threads the diff has no card for
// (see DetachedCommentThread): outdated threads, whose line is gone from the
// current diff, and threads on files the diff doesn't show. GitHub's own
// comments panel lists both, and the overview's Comments count includes
// them, so the list does too. Each thread is given as its root comment
// followed by its replies (groupReviewCommentsByRoot).
//
// A thread in a file the diff shows joins that file's section; one in a file
// it doesn't gets a section of its own after the diff's files, keyed by path
// (no item backs it).
export function buildDetachedCommentSections({
  commentFileByItemId,
  pathToItemId,
  states,
  threads,
}: {
  commentFileByItemId: DiffsHubCommentFileByItemId | null;
  pathToItemId: ReadonlyMap<string, string> | null;
  states: ReadonlyMap<number, PullReviewThreadState> | null;
  threads: readonly (readonly PullReviewComment[])[];
}): DiffsHubSavedCommentItem[] {
  const sections = new Map<string, DiffsHubSavedCommentItem>();
  for (const comments of threads) {
    const root = comments[0];
    if (root == null) {
      continue;
    }
    const diffItemId = pathToItemId?.get(root.path);
    const file =
      diffItemId == null ? undefined : commentFileByItemId?.get(diffItemId);
    const itemId =
      diffItemId != null && file != null ? diffItemId : detachedItemId(root);
    let section = sections.get(itemId);
    if (section == null) {
      section = {
        comments: [],
        fileOrder: file?.fileOrder ?? Number.MAX_SAFE_INTEGER,
        itemId,
        path: root.path,
      };
      sections.set(itemId, section);
    }
    section.comments.push(
      createDetachedEntry(comments, itemId, file != null, states)
    );
  }
  for (const section of sections.values()) {
    section.comments.sort((a, b) => a.lineNumber - b.lineNumber);
  }
  return [...sections.values()];
}

// The sidebar's comment sections with the detached ones merged in: a
// detached thread follows its file's current threads, and files the diff
// doesn't show come last, by path.
export function mergeCommentSections(
  sections: readonly DiffsHubSavedCommentItem[],
  detached: readonly DiffsHubSavedCommentItem[]
): readonly DiffsHubSavedCommentItem[] {
  if (detached.length === 0) {
    return sections;
  }
  const merged = new Map(
    sections.map((section) => [section.itemId, section] as const)
  );
  for (const section of detached) {
    const existing = merged.get(section.itemId);
    merged.set(
      section.itemId,
      existing == null
        ? section
        : { ...existing, comments: [...existing.comments, ...section.comments] }
    );
  }
  return [...merged.values()].sort((a, b) =>
    a.fileOrder !== b.fileOrder
      ? a.fileOrder - b.fileOrder
      : a.path.localeCompare(b.path)
  );
}

function detachedItemId(root: PullReviewComment): string {
  return `github-thread-file:${root.path}`;
}

// A detached thread's row, shaped like createThreadSavedCommentEvent's: it
// mirrors the root comment, at the line it was written on when the current
// diff no longer has one.
function createDetachedEntry(
  comments: readonly PullReviewComment[],
  itemId: string,
  fileInDiff: boolean,
  states: ReadonlyMap<number, PullReviewThreadState> | null
): DiffsHubSavedCommentEntry {
  const [root] = comments as [PullReviewComment, ...PullReviewComment[]];
  const current = createPullReviewThread(root);
  const line = current?.lineNumber ?? root.originalLine;
  const side =
    current?.side ??
    (root.side == null ? 'additions' : toAnnotationSide(root.side));
  const lineNumber = line ?? 0;
  return {
    author: root.author,
    detached: {
      fileInDiff,
      htmlUrl: root.htmlUrl,
      outdated: current == null,
      ...(current == null && root.originalSnippet != null
        ? { snippet: root.originalSnippet }
        : {}),
    },
    itemId,
    key: `thread-${root.id}`,
    lineNumber,
    lineType: root.subjectType === 'file' || line == null ? 'file' : 'context',
    message: createCommentSidebarPreview(root.body),
    participants: uniqueCommentAuthors(comments),
    range: current?.range ?? { end: lineNumber, side, start: lineNumber },
    replyCount: comments.length - 1,
    ...(states?.get(root.id)?.isResolved === true
      ? { resolved: true as const }
      : {}),
    reviewThread: true,
    side,
  };
}
