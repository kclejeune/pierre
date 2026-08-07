'use client';

import { IconPin, IconX } from '@pierre/icons';
import { useState } from 'react';

import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import {
  DashboardShell,
  SECTION_CARD_CLASS,
} from '@/components/DashboardShell';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { PullRequestRow } from '@/components/PullRequestRow';
import { RepoNameInput } from '@/components/RepoNameInput';
import { useDashboardPulls } from '@/components/useDashboardPulls';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import {
  PULL_BUCKETS,
  type PullBucket,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import { isRepoPinned, MAX_PINNED_REPOS } from '@/lib/pinnedRepos';

const BUCKET_COPY: Record<PullBucket, { empty: string; label: string }> = {
  created: { empty: 'you created', label: 'Created' },
  assigned: { empty: 'assigned to you', label: 'Assigned' },
  'review-requested': {
    empty: 'waiting on your review',
    label: 'Review requested',
  },
};

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
            Sign in with GitHub or paste a token to browse your pull requests,
            assigned reviews, and pinned repositories.
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
  const [bucket, setBucket] = useState<PullBucket>('created');
  const { hydrated, pinned, toggle } = usePinnedRepos();
  // Everything below both filters on the pinned list (cards + bucket
  // exclusions), so wait for the single post-mount localStorage read instead
  // of fetching unexcluded and immediately refetching.
  if (!hydrated) {
    return null;
  }
  return (
    <div className="space-y-4">
      <ButtonGroup
        size="sm"
        value={bucket}
        onValueChange={(value) => setBucket(value as PullBucket)}
      >
        {PULL_BUCKETS.map((value) => (
          <ButtonGroupItem key={value} value={value}>
            {BUCKET_COPY[value].label}
          </ButtonGroupItem>
        ))}
      </ButtonGroup>
      <PinnedReposSection
        bucket={bucket}
        pinned={pinned}
        tokenVersion={tokenVersion}
        onToggle={toggle}
      />
      <BucketSection
        bucket={bucket}
        excludeRepos={pinned}
        tokenVersion={tokenVersion}
      />
    </div>
  );
}

function BucketSection({
  bucket,
  excludeRepos,
  tokenVersion,
}: {
  bucket: PullBucket;
  excludeRepos: readonly string[];
  tokenVersion: number;
}) {
  const { error, loading, pulls, totalCount } = useDashboardPulls(
    { kind: 'bucket', bucket, excludeRepos },
    tokenVersion
  );
  // With pinned repos excluded, their pulls appear in the cards above, so
  // the empty state says "other" rather than implying there are none at all.
  const emptyLabel =
    excludeRepos.length > 0
      ? `No other open pull requests ${BUCKET_COPY[bucket].empty}.`
      : `No open pull requests ${BUCKET_COPY[bucket].empty}.`;
  return (
    <div className={SECTION_CARD_CLASS}>
      <SectionRows
        emptyLabel={emptyLabel}
        error={error}
        loading={loading}
        pulls={pulls}
      />
      {totalCount > pulls.length && (
        <p className="text-muted-foreground border-t px-3 py-2 text-xs">
          Showing {pulls.length} of {totalCount} — refine on GitHub for the
          rest.
        </p>
      )}
    </div>
  );
}

function PinnedReposSection({
  bucket,
  onToggle,
  pinned,
  tokenVersion,
}: {
  bucket: PullBucket;
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
        <PinnedRepoCard
          key={repo}
          bucket={bucket}
          repo={repo}
          tokenVersion={tokenVersion}
          onUnpin={() => onToggle(repo)}
        />
      ))}
    </section>
  );
}

function PinnedRepoCard({
  bucket,
  onUnpin,
  repo,
  tokenVersion,
}: {
  bucket: PullBucket;
  onUnpin: () => void;
  repo: string;
  tokenVersion: number;
}) {
  const { error, loading, pulls } = useDashboardPulls(
    { kind: 'repo', repo, bucket },
    tokenVersion
  );
  return (
    <div className={SECTION_CARD_CLASS}>
      <div className="flex items-center justify-between border-b px-3 py-2">
        <span className="text-sm font-medium">{repo}</span>
        <Button
          aria-label={`Unpin ${repo}`}
          variant="ghost"
          size="icon-sm"
          onClick={onUnpin}
        >
          <IconX className="size-4" />
        </Button>
      </div>
      <SectionRows
        emptyLabel={`No open pull requests ${BUCKET_COPY[bucket].empty}.`}
        error={error}
        loading={loading}
        pulls={pulls}
        showRepo={false}
      />
    </div>
  );
}

function SectionRows({
  emptyLabel,
  error,
  loading,
  pulls,
  showRepo = true,
}: {
  emptyLabel: string;
  error: string | null;
  loading: boolean;
  pulls: PullSummary[];
  showRepo?: boolean;
}) {
  if (loading) {
    return (
      <p className="text-muted-foreground animate-pulse p-3 text-sm">
        Loading pull requests…
      </p>
    );
  }
  if (error != null) {
    return <p className="text-destructive p-3 text-sm">{error}</p>;
  }
  if (pulls.length === 0) {
    return <p className="text-muted-foreground p-3 text-sm">{emptyLabel}</p>;
  }
  return (
    <>
      {pulls.map((pull) => (
        <PullRequestRow
          key={`${pull.owner}/${pull.repo}#${pull.number}`}
          pull={pull}
          showRepo={showRepo}
        />
      ))}
    </>
  );
}
