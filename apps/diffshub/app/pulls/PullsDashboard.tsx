'use client';

import { IconPin, IconX } from '@pierre/icons';
import { type Ref, useEffect, useState } from 'react';

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
import {
  type ActivePullsFilter,
  useDashboardPulls,
} from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { cn } from '@/lib/cn';
import {
  involvementsUseReviewRequests,
  isReviewRequestScope,
  normalizePullInvolvements,
  parsePullInvolvements,
  PULL_ACTIVITY_LABELS,
  PULL_INVOLVEMENTS,
  type PullInvolvement,
  type PullSummary,
  type ReviewRequestScope,
} from '@/lib/githubPullSummaries';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';

const DEFAULT_REVIEW_REQUESTS: ReviewRequestScope = 'direct';

// The tabs this page used to have, mapped onto the filter chips that replaced
// them so shared ?bucket= links keep landing on the same list.
// A Map rather than an object literal: ?bucket= is user input, and keys like
// "toString" or "__proto__" would resolve to inherited properties.
const LEGACY_BUCKET_INVOLVES = new Map<string, readonly PullInvolvement[]>([
  ['created', ['authored']],
  ['review-requested', ['review-requested']],
  ['active', ['review-requested', 'reviewed', 'commented']],
  ['assigned', ['assigned']],
]);

// ?involves= and ?requests= keep the filter chips and team-requests switch
// across reloads and shared links. Read on the client so the page stays
// statically prerenderable; defaults are left out of the URL.
function readInvolvesParam(): PullInvolvement[] {
  const params = new URLSearchParams(window.location.search);
  const raw =
    params.get('involves') ??
    LEGACY_BUCKET_INVOLVES.get(params.get('bucket') ?? '')?.join(',') ??
    null;
  return parsePullInvolvements(raw) ?? [];
}

function readReviewRequestsParam(): ReviewRequestScope {
  const value = new URLSearchParams(window.location.search).get('requests');
  return value != null && isReviewRequestScope(value)
    ? value
    : DEFAULT_REVIEW_REQUESTS;
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

function getEmptyCopy(filter: ActivePullsFilter, other: boolean): string {
  const qualifier = other ? 'other ' : '';
  if (filter.involves.length > 0) {
    return `No ${qualifier}open pull requests match these filters.`;
  }
  return filter.reviewRequests === 'teams'
    ? `No ${qualifier}open pull requests involving you or your teams.`
    : `No ${qualifier}open pull requests involving you.`;
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
  const [involves, setInvolves] = useState(readInvolvesParam);
  const selectInvolves = (next: PullInvolvement[]) => {
    setInvolves(next);
    writeSearchParam('involves', next.join(','), '');
  };
  // Rewrites a legacy ?bucket= link to the chips it mapped onto, once on
  // mount; later selections write ?involves= themselves.
  useEffect(() => {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('bucket')) {
      return;
    }
    url.searchParams.delete('bucket');
    const initial = readInvolvesParam();
    if (initial.length > 0) {
      url.searchParams.set('involves', initial.join(','));
    }
    window.history.replaceState(window.history.state, '', url);
  }, []);
  const [reviewRequests, setReviewRequests] = useState(readReviewRequestsParam);
  const selectReviewRequests = (next: ReviewRequestScope) => {
    setReviewRequests(next);
    writeSearchParam('requests', next, DEFAULT_REVIEW_REQUESTS);
  };
  // Only selections with a review-request term carry the switch's value, so
  // flipping it doesn't refetch (or re-key the cache for) the others.
  const filter: ActivePullsFilter = {
    involves,
    reviewRequests: involvementsUseReviewRequests(involves)
      ? reviewRequests
      : undefined,
  };
  // A repo picked from the directory below; its open pulls render in a card
  // above the directory until cleared.
  const [directoryRepo, setDirectoryRepo] = useState<string | null>(null);
  const directoryCard = useRevealDashboardSection<HTMLElement>();
  const { hydrated, pinned, toggle } = usePinnedRepos();
  // Everything below both filters on the pinned list (cards + active-list
  // exclusions), so wait for the single post-mount localStorage read instead
  // of fetching unexcluded and immediately refetching.
  if (!hydrated) {
    return null;
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <InvolvementFilter value={involves} onChange={selectInvolves} />
        {filter.reviewRequests != null && (
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
        filter={filter}
        pinned={pinned}
        tokenVersion={tokenVersion}
        onToggle={toggle}
      />
      <ActiveSection
        excludeRepos={pinned}
        filter={filter}
        tokenVersion={tokenVersion}
      />
      {directoryRepo != null && (
        // The card a directory selection opens: every open pull in that repo
        // (regardless of the filter chips — the point is browsing the repo).
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

// Multi-select involvement chips. "All" (the empty selection) lists every
// pull involving the viewer; selecting chips narrows the search to those
// terms, and selecting every chip folds back into All.
function InvolvementFilter({
  onChange,
  value,
}: {
  onChange: (next: PullInvolvement[]) => void;
  value: readonly PullInvolvement[];
}) {
  const toggle = (involvement: PullInvolvement) =>
    onChange(
      normalizePullInvolvements(
        value.includes(involvement)
          ? value.filter((entry) => entry !== involvement)
          : [...value, involvement]
      )
    );
  return (
    <ButtonGroup
      aria-label="Filter by involvement"
      className="flex-wrap"
      size="sm"
    >
      <ButtonGroupItem
        aria-pressed={value.length === 0}
        selected={value.length === 0}
        title="Every pull request involving you"
        value="all"
        onClick={() => onChange([])}
      >
        All
      </ButtonGroupItem>
      {PULL_INVOLVEMENTS.map((involvement) => (
        <ButtonGroupItem
          key={involvement}
          aria-pressed={value.includes(involvement)}
          selected={value.includes(involvement)}
          title={PULL_ACTIVITY_LABELS[involvement]}
          value={involvement}
          onClick={() => toggle(involvement)}
        >
          {PULL_ACTIVITY_LABELS[involvement]}
        </ButtonGroupItem>
      ))}
    </ButtonGroup>
  );
}

// A repo-scoped pulls card, shared by the pinned cards (scoped to the filter
// chips) and directory selections (every open pull in the repo).
function RepoPullsCard({
  closeLabel,
  emptyLabel,
  filter,
  onClose,
  ref,
  repo,
  tokenVersion,
}: {
  closeLabel: string;
  emptyLabel: string;
  filter?: ActivePullsFilter;
  onClose: () => void;
  ref?: Ref<HTMLElement>;
  repo: string;
  tokenVersion: number;
}) {
  const { error, loading, pulls, retry } = useDashboardPulls(
    { kind: 'repo', repo, filter },
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

function ActiveSection({
  excludeRepos,
  filter,
  tokenVersion,
}: {
  excludeRepos: readonly string[];
  filter: ActivePullsFilter;
  tokenVersion: number;
}) {
  const { error, loading, pulls, retry, totalCount } = useDashboardPulls(
    { kind: 'active', filter, excludeRepos },
    tokenVersion
  );
  // With pinned repos excluded, their pulls appear in the cards above, so
  // the empty state says "other" rather than implying there are none at all.
  const emptyLabel = getEmptyCopy(filter, excludeRepos.length > 0);
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
  filter,
  onToggle,
  pinned,
  tokenVersion,
}: {
  filter: ActivePullsFilter;
  onToggle: (repo: string) => void;
  pinned: readonly string[];
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
          closeLabel={`Unpin ${repo}`}
          emptyLabel={getEmptyCopy(filter, false)}
          filter={filter}
          repo={repo}
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
