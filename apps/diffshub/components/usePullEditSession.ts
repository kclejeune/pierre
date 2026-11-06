'use client';

import {
  cloneFileDiffMetadata,
  type CodeViewItem,
  type CodeViewItemEditCompleteHandler,
  type FileDiffMetadata,
} from '@pierre/diffs';
import type { EditorChangeEvent, EditorType } from '@pierre/diffs/edit';
import { type CodeViewHandle, useStableCallback } from '@pierre/diffs/react';
import { type RefObject, useEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';

import {
  defaultCommitMessage,
  type DirtyFileEntry,
  removeDirtyFile,
  upsertDirtyFile,
} from '@/lib/editSession';
import { isDiffItem } from '@/lib/isDiffItem';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import {
  commitPullFiles,
  fetchPullCommitCapability,
  type PullCommitCapability,
  PullCommitStaleHeadError,
} from '@/lib/pullCommitClient';
import { fetchRepoFile } from '@/lib/repoBrowser';
import { applySuggestion } from '@/lib/suggestedChange';
import { toastRequestError } from '@/lib/toastRequestError';
import type { CommentMetadata } from '@/lib/types';

// State owner for inline pull-request editing: which files are in edit mode,
// which have uncommitted changes, and the batch commit that lands them on the
// head branch. Editing is offered only after the capability preflight
// confirms the viewer's token can actually push (open pull + push access to
// the head repo, or maintainer_can_modify plus base push for fork pulls).

export interface PullEditSession {
  // True once the preflight confirmed a commit can land.
  canCommit: boolean;
  canEdit(item: CodeViewItem<CommentMetadata>): boolean;
  commit(message: string): Promise<void>;
  // Commits a review suggestion to the head branch: lines start..end of the
  // item's file (head side) replaced by `suggestion`. Toasts and throws on
  // failure.
  commitSuggestion(input: SuggestionCommitInput): Promise<void>;
  defaultMessage: string;
  dirtyFiles: readonly DirtyFileEntry[];
  discardFile(itemId: string): void;
  isCommitting: boolean;
  isEditing(itemId: string): boolean;
  // True while an item is being edited or holds uncommitted changes; new
  // review comments are blocked on such files because their line numbers no
  // longer match what GitHub knows.
  isFileLocked(itemId: string): boolean;
  onItemEditChange(
    event: EditorChangeEvent<EditorType, CommentMetadata, undefined>,
    item: CodeViewItem<CommentMetadata>
  ): void;
  onItemEditComplete: CodeViewItemEditCompleteHandler<
    CommentMetadata,
    undefined
  >;
  toggleEdit(itemId: string): void;
}

export interface SuggestionCommitInput {
  end: number;
  itemId: string;
  start: number;
  suggestion: string;
}

interface UsePullEditSessionInput {
  getGitHubToken(): string | undefined;
  githubTokenVersion: number;
  hasGitHubToken: boolean;
  // Presence of the per-file loader — editing a hunks-only diff hydrates full
  // contents through it, so no loader means no editing.
  hasDiffFileLoader: boolean;
  pullRequest: PullRequestRef | undefined;
  retryLoad(): void;
  // Bumped at the start of every load cycle. The session resets and the
  // capability re-fetches per generation so its headSha always describes the
  // diff the user is looking at — a sha cached across reloads would make
  // every commit after an external push fail its compare-and-swap forever.
  viewerKey: number;
  viewerRef: RefObject<CodeViewHandle<CommentMetadata, undefined> | null>;
}

export function usePullEditSession({
  getGitHubToken,
  githubTokenVersion,
  hasGitHubToken,
  hasDiffFileLoader,
  pullRequest,
  retryLoad,
  viewerKey,
  viewerRef,
}: UsePullEditSessionInput): PullEditSession {
  const [capability, setCapability] = useState<PullCommitCapability | null>(
    null
  );
  const [editingIds, setEditingIds] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [dirtyFiles, setDirtyFiles] = useState<readonly DirtyFileEntry[]>([]);
  const [isCommitting, setIsCommitting] = useState(false);
  // Pristine fileDiff snapshots captured at first edit entry — editing
  // mutates diff metadata in place, so discard needs a clone to restore.
  const baselinesRef = useRef(new Map<string, FileDiffMetadata>());
  // Latest editor contents per dirty item. A ref, not state: the editor's
  // onChange fires per keystroke, and routing that through state would change
  // the session object's identity — re-rendering the entire viewer — on
  // every character typed. `dirtyFiles` only tracks membership.
  const contentsRef = useRef(new Map<string, string>());

  // Mirrors dirtyFiles so the reset effect below can detect discarded edits
  // without depending on the state it clears.
  const dirtyFilesRef = useRef<readonly DirtyFileEntry[]>([]);
  dirtyFilesRef.current = dirtyFiles;

  useEffect(() => {
    // A reload rebuilds every item from the fresh diff, so edits made against
    // the previous generation have nothing to attach to — committing them
    // blind would overwrite upstream changes the user never saw. Discard
    // them, but say so: silent loss is worse than the reset.
    if (dirtyFilesRef.current.length > 0) {
      toast.warning(
        `Reloading discarded uncommitted edits to ${dirtyFilesRef.current.length} file${dirtyFilesRef.current.length === 1 ? '' : 's'}.`
      );
    }
    setCapability(null);
    setEditingIds(new Set());
    setDirtyFiles([]);
    baselinesRef.current.clear();
    contentsRef.current.clear();
    const token = getGitHubToken();
    if (
      pullRequest == null ||
      !hasGitHubToken ||
      token == null ||
      token === ''
    ) {
      return;
    }
    const controller = new AbortController();
    fetchPullCommitCapability(pullRequest, token, controller.signal)
      .then((result) => {
        if (!controller.signal.aborted) {
          setCapability(result);
        }
      })
      .catch(() => {
        // Preflight failures just leave editing unavailable; the viewer works
        // exactly as before.
      });
    return () => controller.abort();
  }, [
    pullRequest,
    hasGitHubToken,
    githubTokenVersion,
    getGitHubToken,
    viewerKey,
  ]);

  const canCommit = capability?.canCommit === true;

  const canEdit = useStableCallback((item: CodeViewItem<CommentMetadata>) => {
    return (
      canCommit &&
      hasDiffFileLoader &&
      isDiffItem(item) &&
      item.fileDiff.type !== 'deleted'
    );
  });

  const isEditing = useStableCallback((itemId: string) =>
    editingIds.has(itemId)
  );

  const isFileLocked = useStableCallback(
    (itemId: string) =>
      editingIds.has(itemId) ||
      dirtyFiles.some((entry) => entry.itemId === itemId)
  );

  const toggleEdit = useStableCallback((itemId: string) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    if (viewer == null || item == null || !isDiffItem(item)) {
      return;
    }
    const entering = !editingIds.has(itemId);
    if (entering && !baselinesRef.current.has(itemId)) {
      baselinesRef.current.set(itemId, cloneFileDiffMetadata(item.fileDiff));
    }
    viewer.updateItem({
      ...item,
      // Edit is ignored while collapsed, so entering also expands.
      collapsed: entering ? false : item.collapsed,
      edit: entering,
      version: (item.version ?? 0) + 1,
    });
    setEditingIds((previous) => {
      const next = new Set(previous);
      if (entering) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  });

  const onItemEditChange = useStableCallback(
    (
      { file }: EditorChangeEvent<EditorType, CommentMetadata, undefined>,
      item: CodeViewItem<CommentMetadata>
    ) => {
      contentsRef.current.set(item.id, file.contents);
      setDirtyFiles((previous) =>
        upsertDirtyFile(previous, { itemId: item.id, path: file.name })
      );
    }
  );

  const onItemEditComplete: CodeViewItemEditCompleteHandler<
    CommentMetadata,
    undefined
  > = useStableCallback((event, item, nextItem) => {
    if (item.type !== 'diff' || !('fileDiff' in event)) {
      return 'reject';
    }
    const file = event.newFile;
    if (file == null) {
      return 'reject';
    }
    contentsRef.current.set(item.id, file.contents);
    setDirtyFiles((previous) =>
      upsertDirtyFile(previous, { itemId: item.id, path: file.name })
    );
    // CodeView installs nextItem after acceptance. Re-key the completed diff
    // first so it cannot reuse render output from before the edit session.
    event.fileDiff.cacheKey = `${item.id}:edit:${String(nextItem.version)}`;
    setEditingIds((previous) => {
      if (!previous.has(item.id)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(item.id);
      return next;
    });
    return 'accept';
  });

  const discardFile = useStableCallback((itemId: string) => {
    const viewer = viewerRef.current;
    const item = viewer?.getItem(itemId);
    const baseline = baselinesRef.current.get(itemId);
    if (viewer != null && item != null && isDiffItem(item)) {
      const version = (item.version ?? 0) + 1;
      viewer.updateItem({
        ...item,
        edit: false,
        fileDiff:
          baseline != null ? cloneFileDiffMetadata(baseline) : item.fileDiff,
        version,
      });
    }
    baselinesRef.current.delete(itemId);
    contentsRef.current.delete(itemId);
    setDirtyFiles((previous) => removeDirtyFile(previous, itemId));
    setEditingIds((previous) => {
      if (!previous.has(itemId)) {
        return previous;
      }
      const next = new Set(previous);
      next.delete(itemId);
      return next;
    });
  });

  // The commit pipeline shared by file edits and suggestions: builds the
  // files (with the token, pull, and preflight capability in hand), lands
  // them against the head the preflight saw, then reloads. A head that moved
  // meanwhile offers a reload; other failures toast `failureMessage`. Both
  // rethrow so the caller's UI keeps its state. One commit at a time.
  const runCommit = useStableCallback(
    async (
      buildFiles: (context: {
        capability: PullCommitCapability;
        pullRequest: PullRequestRef;
        token: string;
      }) =>
        | Promise<{ contents: string; path: string }[]>
        | { contents: string; path: string }[],
      message: string,
      failureMessage: string,
      onCommitted?: () => void
    ) => {
      const token = getGitHubToken();
      if (
        pullRequest == null ||
        token == null ||
        token === '' ||
        capability == null ||
        isCommitting
      ) {
        return;
      }
      setIsCommitting(true);
      try {
        const files = await buildFiles({ capability, pullRequest, token });
        const result = await commitPullFiles(pullRequest, token, {
          expectedHeadSha: capability.headSha,
          files,
          message,
        });
        onCommitted?.();
        setCapability((previous) =>
          previous == null ? previous : { ...previous, headSha: result.headSha }
        );
        toast.success(`Committed ${result.commitSha.slice(0, 7)} — reloading.`);
        retryLoad();
      } catch (error) {
        if (error instanceof PullCommitStaleHeadError) {
          toast.error(error.message, {
            action: { label: 'Reload', onClick: () => retryLoad() },
          });
          throw error;
        }
        toastRequestError(error, failureMessage);
      } finally {
        setIsCommitting(false);
      }
    }
  );

  const commit = useStableCallback(async (message: string) => {
    if (dirtyFiles.length === 0) {
      return;
    }
    await runCommit(
      () =>
        dirtyFiles.flatMap(({ itemId, path }) => {
          const contents = contentsRef.current.get(itemId);
          return contents == null ? [] : [{ contents, path }];
        }),
      message,
      'The commit failed.',
      () => {
        setDirtyFiles([]);
        setEditingIds(new Set());
        baselinesRef.current.clear();
        contentsRef.current.clear();
      }
    );
  });

  // Commits a suggestion as its own commit with GitHub's default message:
  // reads the file's full head contents (from the diff when it carries
  // them, else from GitHub at the head the preflight saw) and applies the
  // suggestion. Refused while any file has uncommitted edits: the commit
  // reloads the diff, which would discard them, and an edited target file's
  // lines no longer match the thread's.
  const commitSuggestion = useStableCallback(
    ({ end, itemId, start, suggestion }: SuggestionCommitInput) =>
      runCommit(
        async ({ capability: { headSha }, pullRequest: pull, token }) => {
          const item = viewerRef.current?.getItem(itemId);
          if (item == null || !isDiffItem(item)) {
            throw new Error('The file is no longer in this diff.');
          }
          if (dirtyFilesRef.current.length > 0) {
            throw new Error(
              'Commit or discard your uncommitted edits before applying a suggestion.'
            );
          }
          const { fileDiff } = item;
          const contents = fileDiff.isPartial
            ? (await fetchRepoFile(pull, headSha, fileDiff.name, token))
                .contents
            : fileDiff.additionLines.join('');
          const next = applySuggestion(contents, start, end, suggestion);
          if (next == null) {
            throw new Error(
              "The suggestion's lines are no longer in the file."
            );
          }
          return [{ contents: next, path: fileDiff.name }];
        },
        'Apply suggestion from code review',
        'Committing the suggestion failed.'
      )
  );

  const defaultMessage = useMemo(
    () => defaultCommitMessage(dirtyFiles),
    [dirtyFiles]
  );

  return useMemo(
    () => ({
      canCommit,
      canEdit,
      commit,
      commitSuggestion,
      defaultMessage,
      dirtyFiles,
      discardFile,
      isCommitting,
      isEditing,
      isFileLocked,
      onItemEditChange,
      onItemEditComplete,
      toggleEdit,
    }),
    [
      canCommit,
      canEdit,
      commit,
      commitSuggestion,
      defaultMessage,
      dirtyFiles,
      discardFile,
      isCommitting,
      isEditing,
      isFileLocked,
      onItemEditChange,
      onItemEditComplete,
      toggleEdit,
    ]
  );
}
