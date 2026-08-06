'use client';

import { IconClockArrow, IconPin, IconX } from '@pierre/icons';
import Link from 'next/link';
import { useEffect, useState } from 'react';

import { AppNavbar } from '@/components/AppNavbar';
import { Button } from '@/components/Button';
import { ButtonGroup, ButtonGroupItem } from '@/components/ButtonGroup';
import { DiffsHubLogo } from '@/components/DiffsHubLogo';
import { GitHubTokenControl } from '@/components/GitHubTokenControl';
import { Input } from '@/components/Input';
import { PullRequestRow } from '@/components/PullRequestRow';
import { useDashboardPulls } from '@/components/useDashboardPulls';
import {
  type DiffUrlSuggestion,
  loadSuggestions,
} from '@/components/useDiffUrlSuggestions';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { formatRelativeTime } from '@/lib/formatRelativeTime';
import {
  PULL_BUCKETS,
  type PullBucket,
  type PullSummary,
} from '@/lib/githubPullSummaries';
import {
  isRepoPinned,
  isValidRepoName,
  MAX_PINNED_REPOS,
} from '@/lib/pinnedRepos';
import { loadRecentDiffs, type RecentDiff } from '@/lib/recentDiffs';

const BUCKET_COPY: Record<PullBucket, { empty: string; label: string }> = {
  created: { empty: 'you created', label: 'Created' },
  assigned: { empty: 'assigned to you', label: 'Assigned' },
  'review-requested': {
    empty: 'waiting on your review',
    label: 'Review requested',
  },
};

const SECTION_CARD_CLASS = 'bg-background overflow-hidden rounded-lg border';

export function PullsDashboard() {
  const tokenState = useGitHubToken();
  const { clearToken, hasToken, hydrated, setToken, tokenVersion } = tokenState;

  return (
    <div className="flex min-h-[100svh] flex-col items-center md:bg-[var(--diffshub-sidebar-bg)]">
      <AppNavbar className="w-full" tokenState={tokenState} />
      <div className="w-3xl max-w-[100vw] space-y-6 px-5 pt-2 pb-8 md:pt-4 md:pb-12">
        <header className="flex items-center gap-1.5">
          <Link
            href="/"
            className="flex items-center gap-1.5 text-2xl font-semibold tracking-tight"
          >
            <DiffsHubLogo />
            DiffsHub
          </Link>
          <span className="text-muted-foreground text-2xl font-semibold tracking-tight">
            / pulls
          </span>
        </header>
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
      </div>
    </div>
  );
}

function SignedInDashboard({ tokenVersion }: { tokenVersion: number }) {
  const [bucket, setBucket] = useState<PullBucket>('created');
  return (
    <div className="space-y-6">
      <section className="space-y-3">
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
        <BucketSection bucket={bucket} tokenVersion={tokenVersion} />
      </section>
      <PinnedReposSection bucket={bucket} tokenVersion={tokenVersion} />
      <RecentDiffsSection />
    </div>
  );
}

function BucketSection({
  bucket,
  tokenVersion,
}: {
  bucket: PullBucket;
  tokenVersion: number;
}) {
  const { error, loading, pulls, totalCount } = useDashboardPulls(
    { kind: 'bucket', bucket },
    tokenVersion
  );
  return (
    <div className={SECTION_CARD_CLASS}>
      <SectionRows
        emptyLabel={`No open pull requests ${BUCKET_COPY[bucket].empty}.`}
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
  tokenVersion,
}: {
  bucket: PullBucket;
  tokenVersion: number;
}) {
  const { hydrated, pinned, toggle } = usePinnedRepos();
  if (!hydrated) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <IconPin className="size-4" />
        Pinned repositories
      </h3>
      {pinned.length < MAX_PINNED_REPOS && (
        <AddPinnedRepoInput
          onPin={(repo) => {
            if (!isRepoPinned(pinned, repo)) {
              toggle(repo);
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
          onUnpin={() => toggle(repo)}
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

// Free-text repo input with live GitHub repo-name suggestions, sharing the
// URL bar's suggestion loader (and its cache).
function AddPinnedRepoInput({ onPin }: { onPin: (repo: string) => void }) {
  const [value, setValue] = useState('');
  const [suggestions, setSuggestions] = useState<DiffUrlSuggestion[]>([]);

  useEffect(() => {
    const query = value.trim();
    if (query === '' || isValidRepoName(query)) {
      setSuggestions([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      const slash = query.indexOf('/');
      void loadSuggestions(
        slash === -1
          ? { kind: 'repos', owner: null, query }
          : {
              kind: 'repos',
              owner: query.slice(0, slash),
              query: query.slice(slash + 1),
            }
      ).then((items) => {
        if (!cancelled) {
          setSuggestions(items.slice(0, 5));
        }
      });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [value]);

  const submit = (repo: string) => {
    if (isValidRepoName(repo)) {
      onPin(repo);
      setValue('');
      setSuggestions([]);
    }
  };

  return (
    <div className="space-y-1">
      <form
        className="flex items-center gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submit(value.trim());
        }}
      >
        <Input
          inputSize="sm"
          placeholder="Pin a repository (owner/name)"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
        <Button
          type="submit"
          variant="outline"
          size="sm"
          disabled={!isValidRepoName(value.trim())}
        >
          Pin
        </Button>
      </form>
      {suggestions.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {suggestions.map((suggestion) => (
            <Button
              key={suggestion.key}
              variant="ghost"
              size="xs"
              className="text-muted-foreground"
              onClick={() => submit(suggestion.label)}
            >
              {suggestion.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  );
}

function RecentDiffsSection() {
  const [recents, setRecents] = useState<RecentDiff[]>([]);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setRecents(loadRecentDiffs());
    setHydrated(true);
  }, []);
  if (!hydrated || recents.length === 0) {
    return null;
  }
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-1.5 text-sm font-medium">
        <IconClockArrow className="size-4" />
        Recently viewed
      </h3>
      <div className={SECTION_CARD_CLASS}>
        {/* Every stored entry renders; the height cap (~7 rows) keeps the
            section compact while the rest stays reachable by scrolling. */}
        <div className="max-h-80 overflow-y-auto">
          {recents.map((recent) => (
            <Link
              key={recent.path}
              href={recent.path}
              className="hover:bg-accent/60 flex items-center gap-3 border-b p-3 transition-colors last:border-b-0"
            >
              <span className="min-w-0 flex-1 truncate text-sm">
                {recent.title ?? recent.path}
              </span>
              <span className="text-muted-foreground shrink-0 truncate text-xs">
                {recent.title != null ? recent.path : ''}
              </span>
              <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
                {formatRelativeTime(new Date(recent.viewedAt).toISOString())}
              </span>
            </Link>
          ))}
        </div>
      </div>
    </section>
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
