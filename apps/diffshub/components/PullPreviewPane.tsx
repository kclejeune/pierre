'use client';

import {
  IconArrowUpRight,
  IconEye,
  IconEyeSlash,
  IconShare,
  IconX,
} from '@pierre/icons';
import { useEffect, useMemo, useState } from 'react';

import { AppPermissionsProvider } from './AppPermissionsContext';
import { revealScrollbarWhileScrolling } from './autoHideScrollbar';
import { Button } from './Button';
import { useGitHubEnvironment } from './GitHubEnvironmentProvider';
import { readStoredGitHubToken } from './githubSession';
import {
  LabelChip,
  PANEL_GRID_CLASS,
  PANEL_MAIN_CLASS,
  PANEL_SIDEBAR_CLASS,
  PanelSection,
  PanelSectionSlot,
} from './PanelSection';
import { PullDetailsPanel, usePullDetailsModel } from './PullDetailsControl';
import { MergeStatusCard } from './PullOverview';
import { useQueuedPullPath } from './PullQueueLinkContext';
import {
  fetchReviewThreadStates,
  prefetchReviewThreadStates,
} from './reviewThreadsClient';
import { usePullInfo } from './usePullInfo';
import { cn } from '@/lib/cn';
import {
  githubPullURL,
  pullKey,
  pullRequestRef,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import {
  authorSearchName,
  isAuthorMuted,
  MAX_MUTED_AUTHORS,
  mutedAuthorLabel,
} from '@/lib/mutedAuthors';
import type { PrefetchGroup } from '@/lib/prefetchStore';
import type { PullRequestRef } from '@/lib/pullCommentsClient';
import {
  prefetchPullDetailsSupplement,
  prefetchPullInfo,
} from '@/lib/pullInfoClient';
import type { ConversationCounts } from '@/lib/pullOverview';

// The pane's outer frame: the full height of its grid row beside the list
// (the /pulls page fills the viewport on desktop), scrolling on its own.
const PANE_CLASS =
  'bg-background flex h-full min-h-0 flex-col overflow-hidden rounded-lg border';

function getStoredToken(): string | undefined {
  const token = readStoredGitHubToken();
  return token === '' ? undefined : token;
}

// Starts the requests the preview pane makes for `pull` (its info, the
// details supplement for its head, and its review thread states), so
// selecting it shows the details without waiting on GitHub. The three start
// together when the list row carries the head commit; a row without one
// (an older cached list) waits for the info to name it. The pane's fetchers
// pick the responses up from lib/prefetchStore; `group` lets the caller
// abort the ones nobody took when the pointer moves on. Errors are left for
// the pane's own fetch to retry and report.
export function prefetchPullPreview(pull: PullSummary, group?: PrefetchGroup) {
  const pullRequest = pullRequestRef(pull);
  const token = getStoredToken();
  const info = prefetchPullInfo(pullRequest, token, group);
  if (pull.headSha != null) {
    prefetchPullDetailsSupplement(pullRequest, pull.headSha, token, group);
  }
  // The row's head can trail the pull's (a push since the list loaded);
  // the pane reads the supplement for the info's head, so prefetch that one
  // too when they differ.
  info
    .then(({ headSha }) => {
      if (headSha !== pull.headSha) {
        prefetchPullDetailsSupplement(pullRequest, headSha, token, group);
      }
    })
    .catch(() => undefined);
  if (token != null) {
    prefetchReviewThreadStates(pullRequest, token, group);
  }
}

// The /pulls preview pane for wide screens: the selected pull's overview
// (the same panel the diff view's details popover shows, actions included)
// with a header to open its diff (in a new tab, so the list stays put as a
// queue to work through) or GitHub page, or mute its author. With nothing
// selected it explains how to pick a pull.
export function PullPreviewPane({
  muted,
  onClose,
  onMute,
  onOpenDiff,
  onPullChanged,
  onQuickLook,
  pull,
  tokenVersion,
}: {
  // The dashboard's muted authors and its mute action, for the header's
  // mute button.
  muted: readonly string[];
  onMute(authors: readonly string[]): void;
  // Records the opened diff (recents, the diff view's queue).
  onOpenDiff(pull: PullSummary): void;
  onClose(): void;
  // Called after an action here changed the pull (merge, close, draft), so
  // the list can refetch its rows.
  onPullChanged(): void;
  // Opens the diff in a quick look over the page (Space).
  onQuickLook(pull: PullSummary): void;
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
    <AppPermissionsProvider key={pullKey(pull)} owner={pull.owner}>
      <LoadedPreview
        muted={muted}
        pull={pull}
        tokenVersion={tokenVersion}
        onClose={onClose}
        onMute={onMute}
        onOpenDiff={onOpenDiff}
        onPullChanged={onPullChanged}
        onQuickLook={onQuickLook}
      />
    </AppPermissionsProvider>
  );
}

// The keyboard controls the list offers while the preview is showing (see
// usePreviewKeyboard in PullsDashboard), listed in the empty pane.
const PREVIEW_SHORTCUTS: readonly { keys: string[]; label: string }[] = [
  { keys: ['J', 'K'], label: 'Move between pull requests' },
  { keys: ['Space'], label: 'Quick look at the diff' },
  { keys: ['Enter'], label: 'Open the diff in a new tab' },
  { keys: ['Esc'], label: 'Close the preview' },
];

function Kbd({ children }: { children: string }) {
  return (
    <kbd className="bg-muted text-foreground rounded border px-1 font-sans text-[11px]">
      {children}
    </kbd>
  );
}

function LoadedPreview({
  muted,
  onClose,
  onMute,
  onOpenDiff,
  onPullChanged,
  onQuickLook,
  pull,
  tokenVersion,
}: {
  muted: readonly string[];
  onMute(authors: readonly string[]): void;
  onOpenDiff(pull: PullSummary): void;
  onClose(): void;
  onPullChanged(): void;
  onQuickLook(pull: PullSummary): void;
  pull: PullSummary;
  tokenVersion: number;
}) {
  const queuedPath = useQueuedPullPath(pull.viewerPath);
  const { webURL } = useGitHubEnvironment();
  // Keyed on the ref's fields, not the summary object a refetch replaces.
  const { number, owner, repo } = pull;
  const pullRequest = useMemo(
    () => pullRequestRef({ number, owner, repo }),
    [number, owner, repo]
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
  const githubHref = githubPullURL(webURL, pull);

  return (
    <aside aria-label={`Preview of ${pull.title}`} className={PANE_CLASS}>
      <div className="bg-muted/30 flex h-11 shrink-0 items-center gap-2 border-b px-3">
        {/* The number sits beside the title below; the bar names the repo. */}
        <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {pull.owner}/{pull.repo}
        </span>
        <MuteAuthorButton muted={muted} pull={pull} onMute={onMute} />
        <Button
          type="button"
          className="h-7 px-2.5"
          size="xs"
          variant="outline"
          title="Look at the diff without leaving the list (Space)"
          onClick={() => onQuickLook(pull)}
        >
          <IconEye className="size-3.5" />
          Quick look
        </Button>
        <Button asChild className="h-7 px-2.5" size="xs" variant="outline">
          <a
            href={queuedPath}
            rel="noopener"
            target="_blank"
            title="Open the diff in a new tab (Enter)"
            onClick={() => onOpenDiff(pull)}
          >
            Open diff
            <IconArrowUpRight className="size-3" />
          </a>
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
                  fields.labels != null ||
                  // Requesting or removing a review (the viewer's own, say)
                  // can move the pull in or out of review-requested lists.
                  fields.reviewers != null
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
            <PreviewSkeleton pull={pull} />
          )}
        </div>
      </div>
    </aside>
  );
}

// Mutes the pull's author on the dashboard (lib/mutedAuthors), dropping
// their pulls from the list. Hidden once they're muted; the Author filter
// (or the row's actions menu) unmutes.
function MuteAuthorButton({
  muted,
  onMute,
  pull,
}: {
  muted: readonly string[];
  onMute(authors: readonly string[]): void;
  pull: PullSummary;
}) {
  const author = authorSearchName(pull);
  if (author == null || isAuthorMuted(muted, author)) {
    return null;
  }
  const label = `Mute ${mutedAuthorLabel(author)}`;
  // The muted list is capped (each author adds a search exclusion); past the
  // cap a mute would be dropped, so the button says so instead of no-oping.
  const full = muted.length >= MAX_MUTED_AUTHORS;
  // The title sits on a wrapper: a disabled button takes no pointer events,
  // so its own tooltip wouldn't show.
  return (
    <span
      className="flex"
      title={
        full
          ? `You've muted ${MAX_MUTED_AUTHORS} authors, the most the list can hide. Unmute one from the Author filter first.`
          : `${label}: hide their pull requests from this list`
      }
    >
      <Button
        className="size-7 rounded-md"
        size="icon-sm"
        variant="ghost"
        disabled={full}
        aria-label={label}
        onClick={() => onMute([author])}
      >
        <IconEyeSlash className="size-3.5" />
      </Button>
    </span>
  );
}

// Placeholder laid out like PullDetailsPanel (same container, title row,
// merge status card, and Labels / Reviewers / Description sections in the
// same grid), so the panel replaces it without the content jumping. Shows
// what the list row already knows: the title and labels.
function PreviewSkeleton({ pull }: { pull: PullSummary }) {
  const loadingCell = { kind: 'loading' } as const;
  return (
    <div aria-busy="true" className="@container flex flex-col gap-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 text-sm font-medium">
          {pull.title}
          <span className="text-muted-foreground font-normal">
            {' '}
            #{pull.number}
          </span>
        </div>
        <span className="bg-muted h-5.5 w-16 shrink-0 animate-pulse rounded-full" />
      </div>
      <div className="bg-muted h-4 w-2/3 animate-pulse rounded" />
      <MergeStatusCard
        approvals={loadingCell}
        checks={loadingCell}
        checksExpanded={false}
        comments={loadingCell}
        headline={{
          detail: 'Checks, conversations, and approvals are loading.',
          title: 'Loading merge status…',
          tone: 'neutral',
        }}
        onToggleChecks={() => undefined}
      />
      <div className={cn('flex flex-col gap-3', PANEL_GRID_CLASS)}>
        <div className={PANEL_SIDEBAR_CLASS}>
          <PanelSection heading="Labels">
            <div className="flex flex-wrap items-center gap-1">
              {pull.labels != null && pull.labels.length > 0 ? (
                pull.labels.map((label) => (
                  <LabelChip key={label.name} label={label} />
                ))
              ) : (
                <PanelSectionSlot>
                  <span className="bg-muted h-3 w-16 animate-pulse rounded" />
                </PanelSectionSlot>
              )}
            </div>
          </PanelSection>
          <PanelSection heading="Reviewers">
            <PanelSectionSlot>
              <p className="text-muted-foreground animate-pulse text-xs">
                Loading reviewers…
              </p>
            </PanelSectionSlot>
          </PanelSection>
        </div>
        <div className={PANEL_MAIN_CLASS}>
          <PanelSection heading="Description">
            <div className="bg-muted/60 h-24 animate-pulse rounded-md" />
          </PanelSection>
        </div>
      </div>
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
