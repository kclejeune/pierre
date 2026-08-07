'use client';

import {
  cloneFileDiffMetadata,
  type CodeViewItem,
  type FileContents,
  type FileDiffMetadata,
} from '@pierre/diffs';
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
    item: CodeViewItem<CommentMetadata>,
    file: FileContents
  ): void;
  onItemEditComplete(
    item: CodeViewItem<CommentMetadata>,
    file: FileContents
  ): void;
  toggleEdit(itemId: string): void;
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
  viewerRef: RefObject<CodeViewHandle<CommentMetadata> | null>;
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
    (item: CodeViewItem<CommentMetadata>, file: FileContents) => {
      contentsRef.current.set(item.id, file.contents);
      setDirtyFiles((previous) =>
        upsertDirtyFile(previous, { itemId: item.id, path: file.name })
      );
    }
  );

  const onItemEditComplete = useStableCallback(
    (item: CodeViewItem<CommentMetadata>, file: FileContents) => {
      const viewer = viewerRef.current;
      const current = viewer?.getItem(item.id);
      contentsRef.current.set(item.id, file.contents);
      setDirtyFiles((previous) =>
        upsertDirtyFile(previous, { itemId: item.id, path: file.name })
      );
      if (viewer == null || current == null || !isDiffItem(current)) {
        return;
      }
      // The recommended single session-end write: the session already
      // recomputed the fileDiff's hunks in place, so this stamps a fresh
      // cacheKey (the old key caches pre-edit render output) and turns
      // editing off in one version bump.
      const version = (current.version ?? 0) + 1;
      current.fileDiff.cacheKey = `${current.id}:edit:${version}`;
      viewer.updateItem({
        ...current,
        edit: false,
        version,
      });
      setEditingIds((previous) => {
        if (!previous.has(item.id)) {
          return previous;
        }
        const next = new Set(previous);
        next.delete(item.id);
        return next;
      });
    }
  );

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

  const commit = useStableCallback(async (message: string) => {
    const token = getGitHubToken();
    if (
      pullRequest == null ||
      token == null ||
      token === '' ||
      capability == null ||
      dirtyFiles.length === 0 ||
      isCommitting
    ) {
      return;
    }
    setIsCommitting(true);
    try {
      const result = await commitPullFiles(pullRequest, token, {
        expectedHeadSha: capability.headSha,
        files: dirtyFiles.flatMap(({ itemId, path }) => {
          const contents = contentsRef.current.get(itemId);
          return contents == null ? [] : [{ contents, path }];
        }),
        message,
      });
      setDirtyFiles([]);
      setEditingIds(new Set());
      baselinesRef.current.clear();
      contentsRef.current.clear();
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
      toastRequestError(error, 'The commit failed.');
    } finally {
      setIsCommitting(false);
    }
  });

  const defaultMessage = useMemo(
    () => defaultCommitMessage(dirtyFiles),
    [dirtyFiles]
  );

  return useMemo(
    () => ({
      canCommit,
      canEdit,
      commit,
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
