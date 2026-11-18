'use client';

import { IconShare, IconX } from '@pierre/icons';
import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';

import { AppPermissionsProvider } from './AppPermissionsContext';
import { revealScrollbarWhileScrolling } from './autoHideScrollbar';
import { Button } from './Button';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { readStoredGitHubToken } from './githubSession';
import { PullDetailsPanel, usePullDetailsModel } from './PullDetailsControl';
import { fetchReviewThreadStates } from './reviewThreadsClient';
import { usePullInfo } from './usePullInfo';
import { cn } from '@/lib/cn';
import type { PullSummary } from '@/lib/githubPullSummaries';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import type { ConversationCounts } from '@/lib/pullOverview';
import { recordRecentDiff } from '@/lib/recentDiffs';

// The pane's outer frame: the full height of its grid row beside the list
// (the /pulls page fills the viewport on desktop), scrolling on its own.
const PANE_CLASS =
  'bg-background flex h-full min-h-0 flex-col overflow-hidden rounded-lg border';

function getStoredToken(): string | undefined {
  const token = readStoredGitHubToken();
  return token === '' ? undefined : token;
}

// The /pulls preview pane for wide screens: the selected pull's overview
// (the same panel the diff view's details popover shows, actions included)
// with a header to open its diff or GitHub page. With nothing selected it
// explains how to pick a pull.
export function PullPreviewPane({
  onClose,
  onPullChanged,
  pull,
  tokenVersion,
}: {
  onClose(): void;
  // Called after an action here changed the pull (merge, close, draft), so
  // the list can refetch its rows.
  onPullChanged(): void;
  pull: PullSummary | null;
  tokenVersion: number;
}) {
  if (pull == null) {
    return (
      <aside
        aria-label="Pull request preview"
        className={cn(PANE_CLASS, 'items-center justify-center p-6')}
      >
        <div className="flex flex-col gap-4 text-sm">
          <p className="text-foreground">
            Select a pull request to preview it.
          </p>
          <dl className="text-muted-foreground grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2 text-xs">
            {PREVIEW_SHORTCUTS.map(({ keys, label }) => (
              <div key={label} className="contents">
                <dt className="flex justify-end gap-1">
                  {keys.map((key) => (
                    <Kbd key={key}>{key}</Kbd>
                  ))}
                </dt>
                <dd>{label}</dd>
              </div>
            ))}
          </dl>
        </div>
      </aside>
    );
  }
  return (
    // Keyed so switching pulls starts from a clean panel (edit drafts,
    // expanded checks, loaded supplement).
    <AppPermissionsProvider key={pullKeyOf(pull)} owner={pull.owner}>
      <LoadedPreview
        pull={pull}
        tokenVersion={tokenVersion}
        onClose={onClose}
        onPullChanged={onPullChanged}
      />
    </AppPermissionsProvider>
  );
}

// The keyboard controls the list offers while the preview is showing (see
// usePreviewKeyboard in PullsDashboard), listed in the empty pane.
const PREVIEW_SHORTCUTS: readonly { keys: string[]; label: string }[] = [
  { keys: ['J', 'K'], label: 'Move between pull requests' },
  { keys: ['Enter'], label: 'Open the diff' },
  { keys: ['Esc'], label: 'Close the preview' },
];

function pullKeyOf(pull: PullSummary): string {
  return `${pull.owner}/${pull.repo}#${pull.number}`;
}

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="bg-muted text-foreground rounded border px-1 font-sans text-[11px]">
      {children}
    </kbd>
  );
}

function LoadedPreview({
  onClose,
  onPullChanged,
  pull,
  tokenVersion,
}: {
  onClose(): void;
  onPullChanged(): void;
  pull: PullSummary;
  tokenVersion: number;
}) {
  const { webURL } = useGitHubEnvironment();
  const pullRequest = useMemo(
    (): PullRequestRef => ({
      number: String(pull.number),
      owner: pull.owner,
      repo: pull.repo,
    }),
    [pull.number, pull.owner, pull.repo]
  );
  // Module-level, so its identity is stable across renders.
  const getGitHubToken = getStoredToken;
  // Bumped by Retry; usePullInfo refetches (bypassing its cache) when it
  // changes.
  const [attempt, setAttempt] = useState(0);
  const { loadFailed, mergePullDetails, pullInfo } = usePullInfo({
    getGitHubToken,
    githubTokenVersion: tokenVersion,
    pullRequest,
    tokenHydrated: true,
    viewerKey: attempt,
  });
  const conversations = useConversationCounts(pullRequest, tokenVersion);
  const model = usePullDetailsModel({
    canWrite: getStoredToken() != null,
    conversations,
    getGitHubToken,
    githubTokenVersion: tokenVersion,
    pullInfo,
    pullRequest,
  });
  const githubHref = `${webURL.replace(/\/$/, '')}/${pull.owner}/${pull.repo}/pull/${pull.number}`;

  return (
    <aside aria-label={`Preview of ${pull.title}`} className={PANE_CLASS}>
      <div className="bg-muted/30 flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {/* The number sits beside the title below; the bar names the repo. */}
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {pull.owner}/{pull.repo}
        </span>
        <Button asChild className="h-7 px-2.5" size="xs" variant="outline">
          <Link
            href={pull.viewerPath}
            onClick={() =>
              recordRecentDiff({ path: pull.viewerPath, title: pull.title })
            }
          >
            Open diff
          </Link>
        </Button>
        <Button
          asChild
          className="size-7 rounded-md"
          size="icon-sm"
          variant="ghost"
          title="Open on GitHub"
          aria-label="Open on GitHub"
        >
          <a href={githubHref} rel="noreferrer" target="_blank">
            <IconShare className="size-3.5" />
          </a>
        </Button>
        <Button
          className="size-7 rounded-md"
          size="icon-sm"
          variant="ghost"
          title="Close preview (Esc)"
          aria-label="Close preview"
          onClick={onClose}
        >
          <IconX className="size-3.5" />
        </Button>
      </div>
      {/* The scroller itself has no padding: Chrome insets sticky offsets by
          it, which would float the panel's pinned action footer above the
          bottom edge with content showing beneath. */}
      <div
        className="cv-autohide-scrollbar min-h-0 flex-1 overflow-y-auto"
        onScroll={revealScrollbarWhileScrolling}
      >
        <div className="p-3">
          {model != null ? (
            <PullDetailsPanel
              diffStats={null}
              footerSurfaceClassName="bg-background"
              getGitHubToken={getGitHubToken}
              model={model}
              pullInfo={pullInfo}
              pullRequest={pullRequest}
              onDetailsEdited={(ref, fields) => {
                mergePullDetails(ref, fields);
                if (
                  fields.state != null ||
                  fields.draft != null ||
                  fields.title != null ||
                  fields.labels != null
                ) {
                  onPullChanged();
                }
              }}
              onMerged={onPullChanged}
            />
          ) : loadFailed ? (
            <div className="flex flex-col items-start gap-2 text-sm">
              <p className="text-muted-foreground">
                This pull request&apos;s details didn&apos;t load.
              </p>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Retry
              </Button>
            </div>
          ) : (
            <PreviewSkeleton title={pull.title} />
          )}
        </div>
      </div>
    </aside>
  );
}

// Placeholder shaped like the panel, titled with the row's own title so the
// pane reads as the right pull while the details load.
function PreviewSkeleton({ title }: { title: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-3">
      <p className="text-sm font-medium">{title}</p>
      <div className="bg-muted h-3 w-2/3 animate-pulse rounded" />
      <div className="bg-muted/60 h-28 animate-pulse rounded-md" />
      <div className="bg-muted/60 h-40 animate-pulse rounded-md" />
    </div>
  );
}

// Resolved vs total review conversations for the overview's Comments cell.
// The diff view counts the threads it already loaded; the preview has no
// diff, so it reads the thread states directly. Thread states need a token;
// without one, or on failure, the cell says the count is unavailable.
function useConversationCounts(
  pullRequest: PullRequestRef,
  tokenVersion: number
): ConversationCounts | null {
  const [counts, setCounts] = useState<ConversationCounts | null>(null);
  useEffect(() => {
    setCounts(null);
    const token = getStoredToken();
    if (token == null) {
      setCounts({ kind: 'unavailable' });
      return;
    }
    const controller = new AbortController();
    fetchReviewThreadStates(pullRequest, token, controller.signal).then(
      (states) => {
        if (controller.signal.aborted) {
          return;
        }
        let resolved = 0;
        for (const state of states.values()) {
          if (state.isResolved) {
            resolved += 1;
          }
        }
        setCounts({ kind: 'counted', resolved, total: states.size });
      },
      () => {
        if (!controller.signal.aborted) {
          setCounts({ kind: 'unavailable' });
        }
      }
    );
    return () => controller.abort();
  }, [pullRequest, tokenVersion]);
  return counts;
}
