import type {
  AnnotationSide,
  DiffLineAnnotation,
  FileDiffMetadata,
  SelectedLineRange,
} from '@pierre/diffs';

import { getDocAnnotationSide } from './isDocAnnotation';
import type {
  GitHubDiffSide,
  PullReviewComment,
  PullReviewThread,
  ThreadCommentMetadata,
} from './types';

// A review comment's diff anchor in GitHub API terms: the end line and side,
// plus the start for multi-line comments.
export interface GitHubCommentAnchor {
  line: number;
  path: string;
  side: GitHubDiffSide;
  startLine?: number;
  startSide?: GitHubDiffSide;
}

// File-level comments (GitHub's subject_type "file") are about a whole file
// rather than lines. They render in the viewer's file-level annotation slot,
// line 0, and carry a range ending there. GitHub still reports a line for
// them (1, on the head side), which is ignored.
export const FILE_COMMENT_LINE = 0;

export function createFileCommentRange(): SelectedLineRange {
  return {
    end: FILE_COMMENT_LINE,
    endSide: 'additions',
    side: 'additions',
    start: FILE_COMMENT_LINE,
  };
}

export function isFileCommentRange(range: SelectedLineRange): boolean {
  return range.end === FILE_COMMENT_LINE;
}

// The side a comment's card renders on: its range's end side, or for a
// file-level comment the side the file's diff shows (only the base side for
// a deleted file, as with the rendered-document view).
export function getCommentAnnotationSide(
  range: SelectedLineRange,
  fileDiff: FileDiffMetadata
): AnnotationSide {
  return isFileCommentRange(range)
    ? getDocAnnotationSide(fileDiff)
    : (range.endSide ?? range.side ?? 'additions');
}

export function isGitHubDiffSide(value: unknown): value is GitHubDiffSide {
  return value === 'LEFT' || value === 'RIGHT';
}

// Validates untyped anchor fields (a request body or a GitHub payload mapped
// to camelCase). GitHub rejects a start line equal to the end line, so the
// start anchor is kept only for multi-line comments, its side defaulting to
// the end's.
export function readCommentAnchor(fields: {
  line: unknown;
  path: unknown;
  side: unknown;
  startLine?: unknown;
  startSide?: unknown;
}): GitHubCommentAnchor | null {
  const { line, path, side, startLine, startSide } = fields;
  if (
    typeof path !== 'string' ||
    path === '' ||
    typeof line !== 'number' ||
    !isGitHubDiffSide(side)
  ) {
    return null;
  }
  return typeof startLine === 'number' && startLine !== line
    ? {
        line,
        path,
        side,
        startLine,
        startSide: isGitHubDiffSide(startSide) ? startSide : side,
      }
    : { line, path, side };
}

// The selected-line range an anchor covers; the start falls back to the end
// line and side for single-line comments.
export function getAnchorRange(anchor: {
  line: number;
  side: GitHubDiffSide;
  startLine?: number | null;
  startSide?: GitHubDiffSide | null;
}): SelectedLineRange {
  const endSide = toAnnotationSide(anchor.side);
  return {
    start: anchor.startLine ?? anchor.line,
    side:
      anchor.startLine == null
        ? endSide
        : toAnnotationSide(anchor.startSide ?? anchor.side),
    end: anchor.line,
    endSide,
  };
}

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
  thread: PullReviewThread,
  fileDiff: FileDiffMetadata
): DiffLineAnnotation<ThreadCommentMetadata> {
  return {
    side: getCommentAnnotationSide(thread.range, fileDiff),
    lineNumber: thread.lineNumber,
    metadata: { kind: 'thread', key: thread.key, thread },
  };
}

// Derives the selected-line range a thread anchors to. GitHub review comments
// store the anchor's end line in `line`/`side` and, for multi-line comments,
// the start in `startLine`/`startSide`.
function getThreadRange(comment: PullReviewComment): SelectedLineRange | null {
  return comment.line == null || comment.side == null
    ? null
    : getAnchorRange({ ...comment, line: comment.line, side: comment.side });
}

// Converts a root review comment (with its anchor) into a thread shell.
export function createPullReviewThread(
  root: PullReviewComment
): PullReviewThread | null {
  const range =
    root.subjectType === 'file'
      ? createFileCommentRange()
      : getThreadRange(root);
  if (range == null) {
    return null;
  }
  return {
    comments: [root],
    key: getThreadKey(root.id),
    lineNumber: range.end,
    path: root.path,
    range,
    rootId: root.id,
    side: range.endSide ?? range.side ?? 'additions',
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
