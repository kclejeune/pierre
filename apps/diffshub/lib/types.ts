import type { AnnotationSide, SelectedLineRange } from '@pierre/diffs';
import type { FileTreeGitStatusPatch, GitStatusEntry } from '@pierre/trees';

import type { CommentReaction } from './reactions';

export type ViewerLoadState =
  | 'fetching'
  | 'streaming'
  | 'parsing'
  | 'ready'
  | 'empty'
  | 'error';

// Comment authorship as displayed on cards and in the sidebar. `login` is the
// GitHub login when the author is a real signed-in user or reviewer, or a demo
// persona name otherwise; `avatarUrl` is either a GitHub avatar URL or an
// app-relative persona image.
export interface CommentAuthor {
  avatarUrl: string;
  login: string;
}

export interface SavedCommentMetadata {
  kind: 'saved';
  key: string;
  author: CommentAuthor;
  message: string;
  range: SelectedLineRange;
  // Part of an in-progress batched review: held locally until the review is
  // submitted to GitHub, and rendered with a "Pending" badge.
  pending?: boolean;
}

export interface DraftCommentMetadata {
  kind: 'draft';
  key: string;
  message: string;
  range: SelectedLineRange;
}

// One comment in the in-progress batched review: enough to rebuild the
// GitHub anchor at submit time, to locate the pending annotation card, and —
// with the author — to recreate the card after a reload from persisted state.
// Carries no item id: item ids are load-scoped, so the file path is the
// durable anchor and the item is re-resolved wherever one is needed.
export interface PendingReviewComment {
  author: CommentAuthor;
  // The pull head commit whose diff the comment was written against, used as
  // the review's commit_id. Absent on entries stored before it was recorded,
  // or when the diff loaded without a known head.
  commitId?: string;
  // Set on a pending reply that GitHub's UI started on an existing thread;
  // DiffsHub's own drafts are always new threads.
  inReplyTo?: number;
  key: string;
  message: string;
  path: string;
  // A file-level comment's range ends at line 0 (lib/pullReviewThreads
  // isFileCommentRange); only GitHub's UI starts those.
  range: SelectedLineRange;
  // The draft's comment in the viewer's pending review on GitHub, once saved
  // there (lib/pendingReview), and the text GitHub has for it. A message that
  // differs from `syncedMessage` is an edit not yet saved to GitHub.
  remoteId?: string;
  syncedMessage?: string;
}

// Which side of the pull-request diff a GitHub review comment anchors to,
// in GitHub API terms: LEFT is the base (deletions), RIGHT the head
// (additions).
export type GitHubDiffSide = 'LEFT' | 'RIGHT';

// A single pull-request review comment, normalized from the GitHub API shape
// by the /api/pull-comments route. `line`/`side` are null when the comment is
// outdated (anchored to a diff revision no longer shown).
export interface PullReviewComment {
  author: CommentAuthor;
  body: string;
  createdAt: string;
  // Permalink to the comment on the GitHub instance, straight from the API
  // payload so the app never reconstructs upstream URL shapes.
  htmlUrl: string | null;
  id: number;
  inReplyToId: number | null;
  line: number | null;
  // GraphQL node id, the subject reactions are added to; absent on payloads
  // that don't carry it.
  nodeId?: string;
  path: string;
  // Non-zero emoji reaction tallies, in GitHub's picker order.
  reactions?: CommentReaction[];
  // Set when GitHub couldn't say which reactions are the viewer's: the
  // tallies show, but toggling one could add a reaction the viewer already
  // left, so they are read-only.
  reactionsViewerUnknown?: true;
  side: GitHubDiffSide | null;
  startLine: number | null;
  startSide: GitHubDiffSide | null;
  // Set on a file-level comment (about the whole file, not lines); its
  // line and side are then meaningless.
  subjectType?: 'file';
}

// A pull-request-level comment with no diff anchor: an issue comment on the
// PR conversation, or a submitted review's summary body. Normalized by the
// /api/pull-comments route.
export interface PullDiscussionComment {
  author: CommentAuthor;
  body: string;
  createdAt: string;
  htmlUrl: string | null;
  id: number;
  kind: 'comment' | 'review';
  nodeId?: string;
  reactions?: CommentReaction[];
  reactionsViewerUnknown?: true;
  // GitHub review verdict (APPROVED, CHANGES_REQUESTED, COMMENTED, …) when
  // kind is 'review'; null for conversation comments.
  reviewState: string | null;
}

// A review conversation: the root comment plus its replies in creation order,
// anchored to a line range in one file of the pull-request diff, or to the
// whole file (lineNumber 0, see lib/pullReviewThreads FILE_COMMENT_LINE).
export interface PullReviewThread {
  comments: PullReviewComment[];
  key: string;
  lineNumber: number;
  path: string;
  range: SelectedLineRange;
  rootId: number;
  side: AnnotationSide;
  // Resolution status from GitHub's GraphQL API. Absent when it couldn't be
  // read (anonymous requests, an instance without the fields), in which case
  // the thread renders open with no resolve control.
  state?: PullReviewThreadState;
}

// A review thread's resolution status and what the viewer may do about it.
// `nodeId` is the PullRequestReviewThread's GraphQL id, the subject of the
// resolve/unresolve mutations.
export interface PullReviewThreadState {
  isResolved: boolean;
  nodeId: string;
  resolvedBy: string | null;
  viewerCanResolve: boolean;
  viewerCanUnresolve: boolean;
}

// Annotation payload for a GitHub-backed review thread rendered in the diff.
// The anchor range lives on the thread itself.
export interface ThreadCommentMetadata {
  kind: 'thread';
  key: string;
  thread: PullReviewThread;
}

// Annotation payload for the rendered-markdown document view. Attached as a
// file-level annotation (lineNumber 0) on markdown diff items when the user
// toggles the rendered view; carries no data of its own — the renderer reads
// contents from the owning item's fileDiff.
export interface DocPreviewMetadata {
  kind: 'doc';
  key: string;
}

export type CommentMetadata =
  | SavedCommentMetadata
  | DraftCommentMetadata
  | ThreadCommentMetadata
  | DocPreviewMetadata;

export interface DiffsHubCommentSidebarFile {
  fileOrder: number;
  path: string;
}

export type DiffsHubCommentFileByItemId = ReadonlyMap<
  string,
  DiffsHubCommentSidebarFile
>;

// Whether the line the comment is anchored to is a real addition/deletion or
// an unchanged context line shown in the diff, or 'file' for a file-level
// comment. Tracked so the sidebar can render "Line N" without a misleading
// + / - sigil for context lines, and "the file" for file-level ones.
export type CommentLineType = 'change' | 'context' | 'file';

export interface DiffsHubSavedCommentEvent {
  author: CommentAuthor;
  itemId: string;
  key: string;
  lineNumber: number;
  lineType: CommentLineType;
  message: string;
  // Unique thread authors in first-comment order (root author first), so the
  // sidebar can show who is involved beyond the root author. Local comments
  // carry just their author.
  participants: CommentAuthor[];
  range: SelectedLineRange;
  replyCount: number;
  // Set on GitHub threads marked resolved, so the sidebar can say so.
  resolved?: true;
  side: AnnotationSide;
}

export interface DiffsHubDeletedCommentEvent {
  itemId: string;
  key: string;
}

export interface DiffsHubSavedCommentEntry {
  author: CommentAuthor;
  itemId: string;
  key: string;
  lineNumber: number;
  lineType: CommentLineType;
  message: string;
  participants: CommentAuthor[];
  range: SelectedLineRange;
  replyCount: number;
  resolved?: true;
  side: AnnotationSide;
}

export interface DiffsHubSavedCommentItem {
  comments: DiffsHubSavedCommentEntry[];
  fileOrder: number;
  itemId: string;
  path: string;
}

// The fully pre-computed input this tree needs for a given fetch. It is built
// once at fetch time by snapshotDiffsHubTreeSource and stored alongside the
// viewer items, so later per-item annotation updates do not feed into the
// tree and do not cause it to rebuild.
//
// Streamed publishes link successive snapshots through `previousSource` so the
// tree consumer can recognize append-only growth and apply the delta as
// `model.batch` adds instead of rebuilding the entire path store. The link is
// present only on snapshots that share the same underlying accumulator; the
// initial publish, any non-streamed source, and the first snapshot after the
// accumulator renames an already-published path leave it undefined and force
// a full reset.
//
// `paths` and `pathToItemId` may alias the live accumulator state for
// streamed sources, so consumers must treat them as read-only and must use
// `pathCount` (captured at snapshot time) as the exclusive upper bound when
// iterating `paths`. The `readonly` markers and ReadonlyMap type enforce the
// read-only side; pathCount is what keeps later in-place growth invisible to
// this snapshot.
export interface DiffsHubFileTreeSource {
  gitStatus: readonly GitStatusEntry[];
  gitStatusPatch?: FileTreeGitStatusPatch;
  pathCount: number;
  paths: readonly string[];
  pathToItemId: ReadonlyMap<string, string>;
  previousSource?: DiffsHubFileTreeSource;
}

export interface DiffsHubDiffStats {
  addedLines: number;
  deletedLines: number;
  fileCount: number;
  totalLinesOfCode: number;
}
