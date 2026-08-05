import type {
  AnnotationSide,
  DiffLineAnnotation,
  SelectedLineRange,
} from '@pierre/diffs';

import type {
  GitHubDiffSide,
  PullReviewComment,
  PullReviewThread,
  ThreadCommentMetadata,
} from './types';

export function toAnnotationSide(side: GitHubDiffSide): AnnotationSide {
  return side === 'LEFT' ? 'deletions' : 'additions';
}

export function toGitHubDiffSide(side: AnnotationSide): GitHubDiffSide {
  return side === 'deletions' ? 'LEFT' : 'RIGHT';
}

function getThreadKey(rootId: number): string {
  return `thread-${rootId}`;
}

// The diff annotation carrying a review thread — shared by initial thread
// application and the just-posted-comment path so both render identically.
export function createThreadAnnotation(
  thread: PullReviewThread
): DiffLineAnnotation<ThreadCommentMetadata> {
  return {
    side: thread.side,
    lineNumber: thread.lineNumber,
    metadata: { kind: 'thread', key: thread.key, thread },
  };
}

// Derives the selected-line range a thread anchors to. GitHub review comments
// store the anchor's end line in `line`/`side` and, for multi-line comments,
// the start in `startLine`/`startSide`.
function getThreadRange(comment: PullReviewComment): SelectedLineRange | null {
  if (comment.line == null || comment.side == null) {
    return null;
  }
  const endSide = toAnnotationSide(comment.side);
  if (comment.startLine == null) {
    return { start: comment.line, side: endSide, end: comment.line, endSide };
  }
  return {
    start: comment.startLine,
    side: toAnnotationSide(comment.startSide ?? comment.side),
    end: comment.line,
    endSide,
  };
}

// Converts a root review comment (with its anchor) into a thread shell.
export function createPullReviewThread(
  root: PullReviewComment
): PullReviewThread | null {
  const range = getThreadRange(root);
  if (range == null || root.side == null || root.line == null) {
    return null;
  }
  return {
    comments: [root],
    key: getThreadKey(root.id),
    lineNumber: root.line,
    path: root.path,
    range,
    rootId: root.id,
    side: toAnnotationSide(root.side),
  };
}

// Groups a flat review-comment list (as returned by the GitHub API, in
// creation order) into anchored threads. Replies join the thread of the
// comment they answer, following reply-to chains to the root. Threads whose
// root is outdated (no current line anchor) are dropped along with their
// replies — they cannot be rendered against the current diff.
export function groupPullReviewThreads(
  comments: readonly PullReviewComment[]
): PullReviewThread[] {
  const threads: PullReviewThread[] = [];
  const threadByCommentId = new Map<number, PullReviewThread>();

  for (const comment of comments) {
    if (comment.inReplyToId == null) {
      const thread = createPullReviewThread(comment);
      if (thread != null) {
        threads.push(thread);
        threadByCommentId.set(comment.id, thread);
      }
      continue;
    }

    const thread = threadByCommentId.get(comment.inReplyToId);
    if (thread == null) {
      continue;
    }
    thread.comments.push(comment);
    threadByCommentId.set(comment.id, thread);
  }

  return threads;
}
