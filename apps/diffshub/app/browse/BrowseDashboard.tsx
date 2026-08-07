'use client';

import { IconPin } from '@pierre/icons';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { memo, useMemo, useState } from 'react';

import { Button } from '@/components/Button';
import {
  DashboardShell,
  SECTION_CARD_CLASS,
} from '@/components/DashboardShell';
import { Input } from '@/components/Input';
import { RepoNameInput } from '@/components/RepoNameInput';
import { useGitHubToken } from '@/components/useGitHubToken';
import { usePinnedRepos } from '@/components/usePinnedRepos';
import { useRepoRefs } from '@/components/useRepoRefs';
import type { GitHubRepo } from '@/lib/githubDiffSource';
import { isValidRepoName } from '@/lib/pinnedRepos';
import {
  buildBrowseTreePath,
  buildComparePath,
  buildRefDiffPath,
} from '@/lib/repoBrowser';
import type { RepoRefsData } from '@/lib/repoRefs';

interface BrowseDashboardProps {
  initialRepo?: string;
}

// The /browse dashboard: pick a repository (free text with live suggestions,
// or a pinned repo), then open its file tree at any branch, tag, or commit —
// or jump to the diff a ref carries (commit diff for shas, ref vs. the
// default branch otherwise). The file-tree and diff flows are deliberately
// side by side: every listed ref offers both.
export function BrowseDashboard({ initialRepo }: BrowseDashboardProps) {
  const tokenState = useGitHubToken();
  const token = tokenState.token === '' ? undefined : tokenState.token;
  const [repo, setRepo] = useState<string | null>(
    initialRepo != null && isValidRepoName(initialRepo) ? initialRepo : null
  );
  // Keep ?repo= in the URL so refresh and shared links restore the picker
  // without a navigation.
  const selectRepo = (next: string | null) => {
    setRepo(next);
    window.history.replaceState(
      window.history.state,
      '',
      next == null ? '/browse' : `/browse?repo=${encodeURIComponent(next)}`
    );
  };

  return (
    <DashboardShell section="browse" tokenState={tokenState}>
      <RepoPicker selected={repo} onSelect={selectRepo} />
      {repo != null && tokenState.hydrated && (
        <RepoRefsPanel key={repo} repoName={repo} token={token} />
      )}
    </DashboardShell>
  );
}

// Repo selection: the shared free-text input plus the pinned repos as
// one-click chips.
function RepoPicker({
  onSelect,
  selected,
}: {
  onSelect: (repo: string | null) => void;
  selected: string | null;
}) {
  const { pinned } = usePinnedRepos();
  return (
    <section className="space-y-2">
      <RepoNameInput
        placeholder="Open a repository (owner/name)"
        submitLabel="Open"
        onSubmit={onSelect}
      />
      {pinned.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <IconPin className="text-muted-foreground size-3.5" />
          {pinned.map((pin) => (
            <Button
              key={pin}
              variant={pin === selected ? 'secondary' : 'ghost'}
              size="xs"
              className={pin === selected ? undefined : 'text-muted-foreground'}
              onClick={() => onSelect(pin)}
            >
              {pin}
            </Button>
          ))}
        </div>
      )}
    </section>
  );
}

function RepoRefsPanel({
  repoName,
  token,
}: {
  repoName: string;
  token: string | undefined;
}) {
  const repo = useMemo((): GitHubRepo => {
    const [owner, name] = repoName.split('/');
    return { owner, repo: name };
  }, [repoName]);
  const state = useRepoRefs(repo, token);

  if (state.kind === 'idle' || state.kind === 'loading') {
    return (
      <p className="text-muted-foreground animate-pulse p-3 text-sm">
        Loading branches and tags…
      </p>
    );
  }
  if (state.kind === 'error') {
    return <p className="text-destructive p-3 text-sm">{state.message}</p>;
  }
  const { data } = state;
  return (
    <div className="space-y-4">
      <FreeRefForm data={data} repo={repo} />
      <RefListCard
        defaultBranch={data.defaultBranch}
        heading="Branches"
        refs={data.branches}
        repo={repo}
      />
      {data.tags.length > 0 && (
        <RefListCard
          defaultBranch={data.defaultBranch}
          heading="Tags"
          refs={data.tags}
          repo={repo}
        />
      )}
      {data.truncated && (
        <p className="text-muted-foreground text-xs">
          Showing the first {data.branches.length} branches and{' '}
          {data.tags.length} tags — type any other ref above to open it.
        </p>
      )}
    </div>
  );
}

// Free-form ref entry for anything the lists don't show (commit shas,
// refs/pull/… refs, branches past the listing page), doubling as a
// GitHub-style compare picker: the base defaults to the default branch and
// both inputs suggest the listed refs. "Files" opens the tree at the head;
// "Diff" opens the head commit's own diff when the head is sha-like and no
// base was chosen, otherwise the base...head compare.
function FreeRefForm({ data, repo }: { data: RepoRefsData; repo: GitHubRepo }) {
  const router = useRouter();
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const trimmedBase = base.trim();
  const trimmedHead = head.trim();
  const refListId = `browse-ref-options-${repo.owner}-${repo.repo}`;
  const effectiveBase = trimmedBase === '' ? data.defaultBranch : trimmedBase;
  return (
    <form
      className="flex flex-wrap items-center gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        if (trimmedHead !== '') {
          router.push(buildBrowseTreePath(repo, trimmedHead));
        }
      }}
    >
      <Input
        inputSize="sm"
        className="w-44 flex-none font-mono text-[13px]"
        list={refListId}
        placeholder={`base: ${data.defaultBranch}`}
        value={base}
        onChange={(event) => setBase(event.target.value)}
      />
      <span className="text-muted-foreground font-mono text-[13px]">...</span>
      <Input
        inputSize="sm"
        className="min-w-56 flex-1"
        list={refListId}
        placeholder="Branch, tag, refs/pull/…, or commit sha"
        value={head}
        onChange={(event) => setHead(event.target.value)}
      />
      <Button
        type="submit"
        variant="outline"
        size="sm"
        disabled={trimmedHead === ''}
      >
        Files
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={trimmedHead === '' || trimmedHead === effectiveBase}
        onClick={() => {
          router.push(
            trimmedBase === ''
              ? buildRefDiffPath(repo, trimmedHead, data.defaultBranch)
              : buildComparePath(repo, trimmedBase, trimmedHead)
          );
        }}
      >
        Diff
      </Button>
      <RefDatalist data={data} id={refListId} />
    </form>
  );
}

// Memoized so typing in the compare inputs doesn't reconcile up to 200
// <option> nodes per keystroke.
const RefDatalist = memo(function RefDatalist({
  data,
  id,
}: {
  data: RepoRefsData;
  id: string;
}) {
  return (
    <datalist id={id}>
      {[...data.branches, ...data.tags].map((option) => (
        <option key={option} value={option} />
      ))}
    </datalist>
  );
});

function RefListCard({
  defaultBranch,
  heading,
  refs,
  repo,
}: {
  defaultBranch: string;
  heading: string;
  refs: readonly string[];
  repo: GitHubRepo;
}) {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-medium">{heading}</h3>
      <div className={SECTION_CARD_CLASS}>
        <div className="max-h-80 overflow-y-auto">
          {refs.map((ref) => (
            <div
              key={ref}
              className="hover:bg-accent/50 flex items-center gap-2 border-b px-3 py-1.5 last:border-b-0"
            >
              <Link
                href={buildBrowseTreePath(repo, ref)}
                prefetch={false}
                className="min-w-0 flex-1 truncate font-mono text-[13px] hover:underline"
              >
                {ref}
              </Link>
              {ref === defaultBranch ? (
                <span className="text-muted-foreground rounded-md border px-1.5 py-0.5 text-[11px]">
                  default
                </span>
              ) : (
                <Link
                  href={buildRefDiffPath(repo, ref, defaultBranch)}
                  prefetch={false}
                  className="text-muted-foreground hover:text-foreground text-xs whitespace-nowrap hover:underline"
                >
                  Diff vs {defaultBranch}
                </Link>
              )}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
