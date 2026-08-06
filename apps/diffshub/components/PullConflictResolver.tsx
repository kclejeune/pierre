'use client';

import type { FileContents } from '@pierre/diffs';
import { IconCiWarningFill, IconRefresh, IconX } from '@pierre/icons';
import { useMemo, useState } from 'react';
import { toast } from 'sonner';

import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './Dialog';
import { ThemedFile } from './ThemedFile';
import { ThemedUnresolvedFile } from './ThemedUnresolvedFile';
import { Button } from '@/components/Button';
import { cn } from '@/lib/cn';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import { PullCommitStaleHeadError } from '@/lib/pullCommitClient';
import {
  commitPullMerge,
  type PullConflictsResult,
} from '@/lib/pullConflictsClient';
import { countRemainingConflicts } from '@/lib/pullMerge';

// The conflicted:true variant of the detection result.
export type ConflictedPull = Extract<PullConflictsResult, { conflicted: true }>;

interface PullConflictControlProps {
  conflictedFileCount: number;
  onOpen(): void;
}

// Header chrome button surfaced when the pull has merge conflicts; opens the
// resolver overlay. Sits alongside the Commit and Review controls.
export function PullConflictControl({
  conflictedFileCount,
  onOpen,
}: PullConflictControlProps) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      title="This branch has conflicts with the base branch — resolve and merge"
      className={cn(CHROME_ICON_BUTTON_CLASS, 'w-auto gap-1.5 px-2')}
      onClick={onOpen}
    >
      <IconCiWarningFill className="size-3.5 text-amber-500" />
      Conflicts
      {conflictedFileCount > 0 && (
        <span
          aria-label={`${conflictedFileCount} conflicted files`}
          className="inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-amber-500 px-1 text-[10px] leading-none font-semibold text-white tabular-nums"
        >
          {conflictedFileCount}
        </span>
      )}
    </Button>
  );
}

// Per-file resolution progress. `contents` is the current text — conflict
// markers included until every region is resolved — and is what gets
// committed once `remaining` hits zero.
interface ConflictFileState {
  contents: string;
  editing: boolean;
  // The file contents captured when edit mode was last entered; the editor is
  // the source of truth while editing, so the seed must not follow onChange
  // (feeding edits back as a new file prop would reset the editor).
  editSeed?: FileContents;
  // Once a file has been hand-edited, the resolved-view card renders its
  // current contents instead of the UnresolvedFile instance (which only knows
  // the original markers).
  everEdited: boolean;
  remaining: number;
  // Bumped by Reset to remount the uncontrolled UnresolvedFile instance.
  resetKey: number;
}

interface PullConflictResolverProps {
  conflicts: ConflictedPull;
  pull: PullRequestRef;
  // Returns the requester's stored token ('' when absent).
  getGitHubToken(): string;
  onClose(): void;
  // A branch tip moved mid-resolution; the parent refetches conflicts.
  onStale(): void;
  onMerged(): void;
}

// Full-screen modal for resolving a pull request's merge conflicts: each
// conflicted file renders through UnresolvedFile (choose current / incoming /
// both per region), fully resolved files can be hand-edited for touch-ups,
// and the commit bar writes a real two-parent merge commit to the head
// branch. Built on the shared Dialog so Radix supplies focus trapping,
// escape/overlay close, and the body portal that escapes the viewer grid's
// contain-strict boundary.
export function PullConflictResolver({
  conflicts,
  pull,
  getGitHubToken,
  onClose,
  onStale,
  onMerged,
}: PullConflictResolverProps) {
  const [fileStates, setFileStates] = useState<Map<string, ConflictFileState>>(
    () =>
      new Map(
        conflicts.files.map((file) => [
          file.path,
          {
            contents: file.markedContents,
            editing: false,
            everEdited: false,
            remaining: file.conflictCount,
            resetKey: 0,
          },
        ])
      )
  );
  // Stable FileContents per path so the uncontrolled UnresolvedFile mounts
  // once (an inline object literal would remount it — and drop resolution
  // state — on every resolver render).
  const initialFiles = useMemo(
    () =>
      new Map(
        conflicts.files.map((file) => [
          file.path,
          { contents: file.markedContents, name: file.path } as FileContents,
        ])
      ),
    [conflicts.files]
  );
  const [message, setMessage] = useState('');
  const [isCommitting, setIsCommitting] = useState(false);

  const defaultMessage = `Merge branch '${conflicts.baseRef}' into ${conflicts.headRef}`;
  const resolvedCount = useMemo(
    () =>
      [...fileStates.values()].filter((state) => state.remaining === 0).length,
    [fileStates]
  );
  const allResolved =
    resolvedCount === conflicts.files.length &&
    conflicts.unsupported.length === 0;
  const canCommit = allResolved && !isCommitting && getGitHubToken() !== '';

  function patchFile(path: string, patch: Partial<ConflictFileState>) {
    setFileStates((previous) => {
      const current = previous.get(path);
      if (current == null) {
        return previous;
      }
      const next = new Map(previous);
      next.set(path, { ...current, ...patch });
      return next;
    });
  }

  async function submit() {
    if (!canCommit) {
      return;
    }
    setIsCommitting(true);
    try {
      await commitPullMerge(pull, getGitHubToken(), {
        expectedBaseSha: conflicts.baseSha,
        expectedHeadSha: conflicts.headSha,
        message: message.trim() === '' ? defaultMessage : message.trim(),
        resolvedFiles: conflicts.files.map((file) => ({
          contents: fileStates.get(file.path)?.contents ?? file.markedContents,
          path: file.path,
        })),
      });
      toast.success('Merge committed to the pull request branch.');
      onMerged();
    } catch (error) {
      if (error instanceof PullCommitStaleHeadError) {
        toast.error(error.message, {
          action: { label: 'Reload conflicts', onClick: onStale },
        });
      } else {
        toast.error(
          error instanceof Error ? error.message : 'The merge failed.'
        );
      }
    } finally {
      setIsCommitting(false);
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) {
          onClose();
        }
      }}
    >
      <DialogContent
        className="inset-0 top-0 left-0 flex h-full w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none border-0 p-0 shadow-none sm:max-w-none"
        showCloseButton={false}
      >
        <DialogDescription className="sr-only">
          Resolve each conflicted file, then commit the merge to the pull
          request branch.
        </DialogDescription>
        <header className="flex items-center gap-3 border-b px-4 py-2.5">
          <IconCiWarningFill className="size-4 shrink-0 text-amber-500" />
          <div className="min-w-0 flex-1">
            <DialogTitle className="truncate text-sm leading-normal font-semibold">
              Resolve conflicts — merging{' '}
              <span className="font-mono">{conflicts.baseRef}</span> into{' '}
              <span className="font-mono">{conflicts.headRef}</span>
            </DialogTitle>
          </div>
          <span className="text-muted-foreground text-xs tabular-nums">
            {resolvedCount}/{conflicts.files.length} resolved
          </span>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Close conflict resolver"
            onClick={onClose}
          >
            <IconX className="size-4" />
          </Button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4">
            {conflicts.unsupported.length > 0 && (
              <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium">
                  Some changes cannot be merged here — use git locally instead.
                </p>
                <ul className="text-muted-foreground mt-1 flex flex-col gap-0.5 text-xs">
                  {conflicts.unsupported.map((entry) => (
                    <li key={entry.path}>
                      <span className="font-mono">{entry.path}</span> —{' '}
                      {entry.reason}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {conflicts.autoMerged.length > 0 && (
              <p className="text-muted-foreground text-xs">
                {conflicts.autoMerged.length}{' '}
                {conflicts.autoMerged.length === 1 ? 'file' : 'files'} with
                non-overlapping changes will be merged automatically.
              </p>
            )}
            {conflicts.files.map((file) => {
              const state = fileStates.get(file.path);
              const initialFile = initialFiles.get(file.path);
              if (state == null || initialFile == null) {
                return null;
              }
              return (
                <section key={file.path} className="flex flex-col gap-1.5">
                  <div className="flex items-center gap-2">
                    {state.remaining === 0 ? (
                      <span className="inline-flex items-center rounded-full bg-emerald-600/15 px-2 py-0.5 text-[11px] font-medium text-emerald-600">
                        Resolved
                      </span>
                    ) : (
                      <span className="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-[11px] font-medium text-amber-600">
                        {state.remaining}{' '}
                        {state.remaining === 1 ? 'conflict' : 'conflicts'}
                      </span>
                    )}
                    <div className="flex-1" />
                    {state.remaining === 0 && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        onClick={() =>
                          patchFile(
                            file.path,
                            state.editing
                              ? { editing: false }
                              : {
                                  editing: true,
                                  editSeed: {
                                    contents: state.contents,
                                    name: file.path,
                                  },
                                  everEdited: true,
                                }
                          )
                        }
                      >
                        {state.editing ? 'Done editing' : 'Edit result'}
                      </Button>
                    )}
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-6 gap-1 px-2 text-xs"
                      title="Discard resolutions for this file and start over"
                      onClick={() =>
                        patchFile(file.path, {
                          contents: file.markedContents,
                          editing: false,
                          editSeed: undefined,
                          everEdited: false,
                          remaining: file.conflictCount,
                          resetKey: state.resetKey + 1,
                        })
                      }
                    >
                      <IconRefresh className="size-3" />
                      Reset
                    </Button>
                  </div>
                  {state.editing && state.editSeed != null ? (
                    <ThemedFile
                      file={state.editSeed}
                      edit
                      editorOptions={{
                        onChange: (updated: FileContents) => {
                          patchFile(file.path, {
                            contents: updated.contents,
                            remaining: countRemainingConflicts(
                              updated.contents
                            ),
                          });
                        },
                      }}
                      className="overflow-hidden rounded-lg border"
                    />
                  ) : state.everEdited ? (
                    // The UnresolvedFile instance only knows the original
                    // markers, so after a hand-edit the card shows the current
                    // contents read-only instead.
                    <ThemedFile
                      file={{ contents: state.contents, name: file.path }}
                      className="overflow-hidden rounded-lg border"
                    />
                  ) : (
                    <ThemedUnresolvedFile
                      key={state.resetKey}
                      file={initialFile}
                      onMergeConflictResolve={(updated) => {
                        patchFile(file.path, {
                          contents: updated.contents,
                          remaining: countRemainingConflicts(updated.contents),
                        });
                      }}
                      className="overflow-hidden rounded-lg border"
                    />
                  )}
                </section>
              );
            })}
          </div>
        </div>

        <footer className="border-t px-4 py-3">
          <form
            className="mx-auto flex w-full max-w-5xl items-center gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              value={message}
              disabled={isCommitting}
              placeholder={defaultMessage}
              aria-label="Merge commit message"
              className="border-border h-8 min-w-0 flex-1 rounded-md border bg-transparent px-3 font-mono text-[13px] text-inherit placeholder:opacity-60 focus:outline-none"
              onChange={({ currentTarget }) => setMessage(currentTarget.value)}
            />
            <Button
              type="submit"
              variant="default"
              size="sm"
              disabled={!canCommit}
            >
              {isCommitting ? 'Committing…' : 'Commit merge'}
            </Button>
          </form>
        </footer>
      </DialogContent>
    </Dialog>
  );
}
