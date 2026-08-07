import type { AnnotationSide, SelectedLineRange } from '@pierre/diffs';
import type { FileTreeGitStatusPatch, GitStatusEntry } from '@pierre/trees';

export type ViewerLoadState =
  | 'fetching'
  | 'streaming'
  | 'parsing'
  | 'ready'
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
  key: string;
  message: string;
  path: string;
  range: SelectedLineRange;
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
  path: string;
  side: GitHubDiffSide | null;
  startLine: number | null;
  startSide: GitHubDiffSide | null;
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
  // GitHub review verdict (APPROVED, CHANGES_REQUESTED, COMMENTED, …) when
  // kind is 'review'; null for conversation comments.
  reviewState: string | null;
}

// A review conversation: the root comment plus its replies in creation order,
// anchored to a line range in one file of the pull-request diff.
export interface PullReviewThread {
  comments: PullReviewComment[];
  key: string;
  lineNumber: number;
  path: string;
  range: SelectedLineRange;
  rootId: number;
  side: AnnotationSide;
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
// an unchanged context line shown in the diff. Tracked so the sidebar can
// render "Line N" without a misleading + / - sigil for context lines.
export type CommentLineType = 'change' | 'context';

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
// initial publish and any non-streamed source leave it undefined and force a
// full reset.
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
