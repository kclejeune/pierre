'use client';

import { IconBranch } from '@pierre/icons';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';

import { Button } from './Button';
import { CHROME_ICON_BUTTON_CLASS } from './chromeButtonStyles';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from './DropdownMenu';
import { useDropdownChromeStyle } from './useDropdownChromeStyle';
import { cn } from '@/lib/cn';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import {
  commitRangeViewerHref,
  commitRangeViewerPath,
  fetchPullCommitsList,
  type PullCommitSummary,
} from '@/lib/pullCommitsList';
import { recordRecentDiff } from '@/lib/recentDiffs';

interface PullCommitRangePickerProps {
  getGitHubToken(): string | undefined;
  // Bumped when the saved token changes so the cached listing refetches
  // under the new identity.
  githubTokenVersion: number;
  pullRequest: PullRequestRef;
}

type CommitsState =
  | { kind: 'idle' | 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'ready'; commits: PullCommitSummary[] };

// The header's commit-range picker: lists the pull's commits (oldest first)
// and opens the diff of any selection — one commit's own diff, or a compare
// spanning a start/end pair — in the same viewer. Selection is two clicks;
// clicking a third commit restarts from it.
export function PullCommitRangePicker({
  getGitHubToken,
  githubTokenVersion,
  pullRequest,
}: PullCommitRangePickerProps) {
  const router = useRouter();
  const dropdownThemeStyle = useDropdownChromeStyle();
  const [open, setOpen] = useState(false);
  const [commitsState, setCommitsState] = useState<CommitsState>({
    kind: 'idle',
  });
  // 0–2 selected shas, in click order; range math normalizes them.
  const [selection, setSelection] = useState<string[]>([]);

  // The listing is fetched on first open and kept until the pull or token
  // changes; both also drop any selection made against the old listing.
  useEffect(() => {
    setCommitsState({ kind: 'idle' });
    setSelection([]);
  }, [githubTokenVersion, pullRequest]);
  useEffect(() => {
    if (!open || commitsState.kind !== 'idle') {
      return;
    }
    const controller = new AbortController();
    setCommitsState({ kind: 'loading' });
    fetchPullCommitsList(pullRequest, getGitHubToken(), controller.signal).then(
      (commits) => {
        if (!controller.signal.aborted) {
          setCommitsState({ kind: 'ready', commits });
        }
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setCommitsState({
            kind: 'error',
            message:
              error instanceof Error
                ? error.message
                : 'Loading the commit list failed.',
          });
        }
      }
    );
    return () => controller.abort();
  }, [commitsState.kind, getGitHubToken, open, pullRequest]);

  const commits = commitsState.kind === 'ready' ? commitsState.commits : [];
  const selectedIndexes = selection
    .map((sha) => commits.findIndex((commit) => commit.sha === sha))
    .filter((index) => index >= 0);
  const rangeStart = Math.min(...selectedIndexes);
  const rangeEnd = Math.max(...selectedIndexes);

  const viewerPath =
    selectedIndexes.length === 0
      ? null
      : commitRangeViewerPath(
          { owner: pullRequest.owner, repo: pullRequest.repo },
          commits[rangeStart],
          commits[rangeEnd]
        );
  const viewerHref =
    viewerPath == null ? null : commitRangeViewerHref(viewerPath, pullRequest);

  const toggleCommit = (sha: string) => {
    setSelection((current) => {
      if (current.includes(sha)) {
        return current.filter((selected) => selected !== sha);
      }
      // A third pick restarts the selection from that commit.
      return current.length >= 2 ? [sha] : [...current, sha];
    });
  };

  const viewSelection = () => {
    if (viewerHref == null) {
      return;
    }
    const label =
      rangeStart === rangeEnd
        ? `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} @ ${commits[rangeStart].sha.slice(0, 7)}`
        : `${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number} commits ${rangeStart + 1}–${rangeEnd + 1}`;
    recordRecentDiff({ path: viewerHref, title: label });
    setOpen(false);
    router.push(viewerHref);
  };

  return (
    <DropdownMenu modal={false} open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          title="View changes from a commit range"
          className={cn(CHROME_ICON_BUTTON_CLASS, 'w-auto gap-1.5 px-2')}
        >
          <IconBranch className="size-3.5" />
          Commits
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-[420px] max-w-[90vw] p-3"
        style={dropdownThemeStyle}
      >
        <div className="flex flex-col gap-2">
          <div className="text-sm font-medium">View a commit range</div>
          <p className="text-muted-foreground text-xs">
            Pick one commit for its own diff, or a start and end commit for
            everything between them.
          </p>
          {commitsState.kind === 'loading' && (
            <p className="text-muted-foreground animate-pulse py-2 text-sm">
              Loading commits…
            </p>
          )}
          {commitsState.kind === 'error' && (
            <div className="flex items-center justify-between gap-2 py-2">
              <p className="text-destructive text-sm">{commitsState.message}</p>
              <Button
                type="button"
                variant="outline"
                size="xs"
                onClick={() => setCommitsState({ kind: 'idle' })}
              >
                Retry
              </Button>
            </div>
          )}
          {commitsState.kind === 'ready' && (
            <>
              <ul className="flex max-h-72 flex-col overflow-y-auto">
                {commits.map((commit, index) => (
                  <CommitRow
                    key={commit.sha}
                    commit={commit}
                    endpoint={selection.includes(commit.sha)}
                    inRange={
                      selectedIndexes.length === 2 &&
                      index > rangeStart &&
                      index < rangeEnd
                    }
                    onToggle={() => toggleCommit(commit.sha)}
                  />
                ))}
              </ul>
              <div className="flex items-center justify-between gap-2 border-t border-[var(--diffshub-annotation-border,var(--color-border))] pt-2">
                <span className="text-muted-foreground text-xs">
                  {selection.length === 0
                    ? `${commits.length === 1 ? '1 commit' : `${commits.length} commits`} in this pull request`
                    : rangeStart === rangeEnd
                      ? `Commit ${commits[rangeStart]?.sha.slice(0, 7) ?? ''} selected`
                      : `Commits ${rangeStart + 1}–${rangeEnd + 1} of ${commits.length} selected`}
                </span>
                <span className="flex gap-1.5">
                  {selection.length > 0 && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => setSelection([])}
                    >
                      Clear
                    </Button>
                  )}
                  <Button
                    type="button"
                    variant="default"
                    size="xs"
                    disabled={viewerHref == null}
                    onClick={viewSelection}
                  >
                    View changes
                  </Button>
                </span>
              </div>
            </>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CommitRow({
  commit,
  endpoint,
  inRange,
  onToggle,
}: {
  commit: PullCommitSummary;
  // Whether this commit is a selected start/end, vs. merely spanned.
  endpoint: boolean;
  inRange: boolean;
  onToggle(): void;
}) {
  return (
    <li>
      <button
        type="button"
        aria-pressed={endpoint}
        className={cn(
          'flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--diffshub-card-hover-bg,var(--color-muted))]',
          endpoint && 'bg-[var(--diffshub-card-bg,var(--color-muted))]',
          inRange && 'bg-[var(--diffshub-card-bg,var(--color-muted))]/50'
        )}
        onClick={onToggle}
      >
        <span className="text-muted-foreground shrink-0 font-mono text-[11px]">
          {commit.sha.slice(0, 7)}
        </span>
        <span
          className="min-w-0 flex-1 truncate text-xs"
          title={commit.headline}
        >
          {commit.headline}
        </span>
        {commit.authorLogin != null && (
          <CommentAuthorAvatar
            author={{
              avatarUrl: commit.authorAvatarUrl ?? '',
              login: commit.authorLogin,
            }}
            className="size-4 self-center"
          />
        )}
      </button>
    </li>
  );
}
