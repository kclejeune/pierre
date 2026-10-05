'use client';

import { IconPin, IconX } from '@pierre/icons';
import { type Ref, useState } from 'react';

import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import {
  DashboardSectionState,
  SkeletonRows,
} from '@/components/DashboardSectionState';
import {
  DashboardShell,
  SECTION_CARD_CLASS,
  useRevealDashboardSection,
} from '@/components/DashboardShell';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { PullRequestRow } from '@/components/PullRequestRow';
import { RepoDirectory } from '@/components/RepoDirectory';
import { RepoNameInput } from '@/components/RepoNameInput';
import { Switch } from '@/components/Switch';
import { useDashboardPulls } from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { cn } from '@/lib/cn';
import {
  bucketUsesReviewRequests,
  isPullBucket,
  isReviewRequestScope,
  PULL_BUCKETS,
  type PullBucket,
  type PullSummary,
  type ReviewRequestScope,
} from '@/lib/githubPullSummaries';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';

const DEFAULT_BUCKET: PullBucket = 'created';

const DEFAULT_REVIEW_REQUESTS: ReviewRequestScope = 'direct';

// ?bucket= and ?requests= keep the tab and team-requests switch across
// reloads and shared links. Read on the client so the page stays statically
// prerenderable; defaults are left out of the URL.
function readSearchParam<T extends string>(
  name: string,
  isValid: (value: string) => value is T,
  fallback: T
): T {
  const value = new URLSearchParams(window.location.search).get(name);
  return value != null && isValid(value) ? value : fallback;
}

function writeSearchParam(name: string, value: string, fallback: string) {
  const url = new URL(window.location.href);
  if (value === fallback) {
    url.searchParams.delete(name);
  } else {
    url.searchParams.set(name, value);
  }
  window.history.replaceState(window.history.state, '', url);
}

// emptyWithTeams replaces empty while the team-requests switch is on, for
// buckets whose results it widens.
const BUCKET_COPY: Record<
  PullBucket,
  { empty: string; emptyWithTeams?: string; label: string }
> = {
  created: { empty: 'you created', label: 'Created' },
  assigned: { empty: 'assigned to you', label: 'Assigned' },
  'review-requested': {
    empty: 'waiting on your review',
    emptyWithTeams: "waiting on your or your teams' review",
    label: 'Review requested',
  },
  active: {
    empty: "waiting on you or that you've commented on",
    emptyWithTeams: "waiting on you or your teams, or that you've commented on",
    label: 'Active',
  },
};

function getEmptyCopy(
  bucket: PullBucket,
  reviewRequests: ReviewRequestScope | undefined
): string {
  const copy = BUCKET_COPY[bucket];
  return reviewRequests === 'teams' && copy.emptyWithTeams != null
    ? copy.emptyWithTeams
    : copy.empty;
}

export function PullsDashboard() {
  const tokenState = useGitHubToken();
  const { clearToken, hasToken, hydrated, setToken, tokenVersion } = tokenState;

  return (
    <DashboardShell section="pulls" tokenState={tokenState}>
      {!hydrated ? null : hasToken ? (
        <SignedInDashboard tokenVersion={tokenVersion} />
      ) : (
        <div className={SECTION_CARD_CLASS}>
          <p className="text-muted-foreground border-b px-4 py-3 text-sm">
            Sign in with GitHub to see pull requests you opened, were asked to
            review, commented on, or were assigned.
          </p>
          <GitHubTokenControl
            active={hasToken}
            className="px-4 py-3"
            onClear={clearToken}
            onSave={setToken}
            title="GitHub access"
          />
        </div>
      )}
    </DashboardShell>
  );
}

function SignedInDashboard({ tokenVersion }: { tokenVersion: number }) {
  const [bucket, setBucket] = useState(() =>
    readSearchParam('bucket', isPullBucket, DEFAULT_BUCKET)
  );
  const selectBucket = (next: PullBucket) => {
    setBucket(next);
    writeSearchParam('bucket', next, DEFAULT_BUCKET);
  };
  const [reviewRequests, setReviewRequests] = useState(() =>
    readSearchParam('requests', isReviewRequestScope, DEFAULT_REVIEW_REQUESTS)
  );
  const selectReviewRequests = (next: ReviewRequestScope) => {
    setReviewRequests(next);
    writeSearchParam('requests', next, DEFAULT_REVIEW_REQUESTS);
  };
  // Only buckets with a review-request qualifier carry the switch's value, so
  // flipping it doesn't refetch (or re-key the cache for) the others.
  const bucketReviewRequests = bucketUsesReviewRequests(bucket)
    ? reviewRequests
    : undefined;
  // A repo picked from the directory below; its open pulls render in a card
  // above the directory until cleared.
  const [directoryRepo, setDirectoryRepo] = useState<string | null>(null);
  const directoryCard = useRevealDashboardSection<HTMLElement>();
  const { hydrated, pinned, toggle } = usePinnedRepos();
  // Everything below both filters on the pinned list (cards + bucket
  // exclusions), so wait for the single post-mount localStorage read instead
  // of fetching unexcluded and immediately refetching.
  if (!hydrated) {
    return null;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <ButtonGroup
          size="sm"
          value={bucket}
          onValueChange={(value) => selectBucket(value as PullBucket)}
        >
          {PULL_BUCKETS.map((value) => (
            <ButtonGroupItem key={value} value={value}>
              {BUCKET_COPY[value].label}
            </ButtonGroupItem>
          ))}
        </ButtonGroup>
        {bucketReviewRequests != null && (
          <label
            className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs"
            title="Also count review requests sent to teams you're on"
          >
            Include team requests
            <Switch
              checked={reviewRequests === 'teams'}
              onCheckedChange={(checked) =>
                selectReviewRequests(checked ? 'teams' : 'direct')
              }
            />
          </label>
        )}
      </div>
      <PinnedReposSection
        bucket={bucket}
        pinned={pinned}
        reviewRequests={bucketReviewRequests}
        tokenVersion={tokenVersion}
        onToggle={toggle}
      />
      <BucketSection
        bucket={bucket}
        excludeRepos={pinned}
        reviewRequests={bucketReviewRequests}
        tokenVersion={tokenVersion}
      />
      {directoryRepo != null && (
        // The card a directory selection opens: every open pull in that repo
        // (regardless of the active bucket — the point is browsing the repo).
        <RepoPullsCard
          key={directoryRepo}
          ref={directoryCard.ref}
          closeLabel={`Close ${directoryRepo}`}
          emptyLabel="No open pull requests in this repository."
          repo={directoryRepo}
          tokenVersion={tokenVersion}
          onClose={() => setDirectoryRepo(null)}
        />
      )}
      <section className="space-y-3">
        <h3 className="text-sm font-medium">Your repositories</h3>
        <RepoDirectory
          onSelectRepo={(repo) => {
            setDirectoryRepo(repo);
            directoryCard.requestReveal();
          }}
          selectedRepo={directoryRepo}
          tokenVersion={tokenVersion}
        />
      </section>
    </div>
  );
}

// A repo-scoped pulls card, shared by the pinned cards (scoped to the active
// bucket tab) and directory selections (every open pull in the repo).
function RepoPullsCard({
  bucket,
  closeLabel,
  emptyLabel,
  onClose,
  ref,
  repo,
  reviewRequests,
  tokenVersion,
}: {
  bucket?: PullBucket;
  closeLabel: string;
  emptyLabel: string;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
  repo: string;
  reviewRequests?: ReviewRequestScope;
  tokenVersion: number;
}) {
  const { error, loading, pulls, retry } = useDashboardPulls(
    { kind: 'repo', repo, bucket, reviewRequests },
    tokenVersion
  );
  return (
    <section
      ref={ref}
      tabIndex={-1}
      aria-label={`Open pull requests in ${repo}`}
      aria-busy={loading}
      className={cn(SECTION_CARD_CLASS, 'scroll-mt-4 outline-none')}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{repo}</span>
        <Button
          aria-label={closeLabel}
          variant="ghost"
          size="icon-sm"
          onClick={onClose}
        >
          <IconX className="size-4" />
        </Button>
      </div>
      <SectionRows
        emptyLabel={emptyLabel}
        error={error}
        loading={loading}
        pulls={pulls}
        showRepo={false}
        onRetry={retry}
      />
    </section>
  );
}

function BucketSection({
  bucket,
  excludeRepos,
  reviewRequests,
  tokenVersion,
}: {
  bucket: PullBucket;
  excludeRepos: readonly string[];
  reviewRequests?: ReviewRequestScope;
  tokenVersion: number;
}) {
  const { error, loading, pulls, retry, totalCount } = useDashboardPulls(
    { kind: 'bucket', bucket, excludeRepos, reviewRequests },
    tokenVersion
  );
  // With pinned repos excluded, their pulls appear in the cards above, so
  // the empty state says "other" rather than implying there are none at all.
  const emptyLabel =
    excludeRepos.length > 0
      ? `No other open pull requests ${getEmptyCopy(bucket, reviewRequests)}.`
      : `No open pull requests ${getEmptyCopy(bucket, reviewRequests)}.`;
  return (
    <div className={SECTION_CARD_CLASS} aria-busy={loading}>
      <SectionRows
        emptyLabel={emptyLabel}
        error={error}
        loading={loading}
        pulls={pulls}
        onRetry={retry}
      />
      {totalCount > pulls.length && (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">
          Showing the {pulls.length} most recently updated of {totalCount}.
          Search on GitHub to see the rest.
        </p>
      )}
    </div>
  );
}

function PinnedReposSection({
  bucket,
  onToggle,
  pinned,
  reviewRequests,
  tokenVersion,
}: {
  bucket: PullBucket;
  onToggle: (repo: string) => void;
  pinned: readonly string[];
  reviewRequests?: ReviewRequestScope;
  tokenVersion: number;
}) {
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <IconPin className="size-4" />
        Pinned repositories
      </h3>
      {pinned.length < MAX_PINNED_REPOS && (
        <RepoNameInput
          placeholder="Pin a repository (owner/name)"
          submitLabel="Pin"
          onSubmit={(repo) => {
            if (!isRepoPinned(pinned, repo)) {
              onToggle(repo);
            }
          }}
        />
      )}
      {pinned.map((repo) => (
        <RepoPullsCard
          key={repo}
          bucket={bucket}
          closeLabel={`Unpin ${repo}`}
          emptyLabel={`No open pull requests ${getEmptyCopy(bucket, reviewRequests)}.`}
          repo={repo}
          reviewRequests={reviewRequests}
          tokenVersion={tokenVersion}
          onClose={() => onToggle(repo)}
        />
      ))}
    </section>
  );
}

function SectionRows({
  emptyLabel,
  error,
  loading,
  onRetry,
  pulls,
  showRepo = true,
}: {
  emptyLabel: string;
  error: Error | null;
  loading: boolean;
  onRetry(): void;
  pulls: PullSummary[];
  showRepo?: boolean;
}) {
  return (
    <DashboardSectionState
      emptyLabel={emptyLabel}
      error={error}
      isEmpty={pulls.length === 0}
      loading={loading}
      loadingLabel="Loading pull requests…"
      skeleton={<SkeletonRows variant="pull" />}
      onRetry={onRetry}
    >
      {pulls.map((pull) => (
        <PullRequestRow
          key={`${pull.owner}/${pull.repo}#${pull.number}`}
          pull={pull}
          showRepo={showRepo}
        />
      ))}
    </DashboardSectionState>
  );
}
