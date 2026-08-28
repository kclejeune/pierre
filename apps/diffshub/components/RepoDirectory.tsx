'use client';

import { IconBuilding, IconLock, IconPerson } from '@pierre/icons';
import { useMemo, useState } from 'react';

import { Button } from './Button';
import { CommentAuthorAvatar } from './CommentAuthorAvatar';
import { SECTION_CARD_CLASS } from './DashboardShell';
import { Input } from './Input';
import { useRepoDirectory } from './useRepoDirectory';
import { cn } from '@/lib/cn';
import {
  filterRepoGroups,
  type RepoDirectoryGroup,
  type RepoDirectoryOwner,
  type RepoDirectoryRepo,
} from '@/lib/repoDirectory';

interface RepoDirectoryProps {
  // What selecting a repo does on this page (open its tree on /browse, show
  // its pulls on /pulls) — named so the section can label itself.
  onSelectRepo(fullName: string): void;
  selectedRepo?: string | null;
  tokenVersion: number;
}

// The dashboards' shared repository directory: the viewer's orgs as filter
// chips, their repositories grouped under each org/owner, and one search box
// filtering both levels (an owner match keeps the whole group, otherwise
// repos filter by name).
export function RepoDirectory({
  onSelectRepo,
  selectedRepo,
  tokenVersion,
}: RepoDirectoryProps) {
  const { error, groups, hasMore, loadMore, loading, loadingMore, refresh } =
    useRepoDirectory(tokenVersion);
  const [query, setQuery] = useState('');
  const [ownerFilter, setOwnerFilter] = useState<string | null>(null);

  // The chip row keeps every owner visible while searching, so the query
  // narrows repos and the chips narrow owners independently.
  const searched = useMemo(
    () => filterRepoGroups(groups, query),
    [groups, query]
  );
  const visible = useMemo(
    () =>
      ownerFilter == null
        ? searched
        : searched.filter((group) => group.owner.login === ownerFilter),
    [ownerFilter, searched]
  );

  if (loading) {
    return (
      <p className="text-muted-foreground animate-pulse p-3 text-sm">
        Loading your repositories…
      </p>
    );
  }
  if (error != null && groups.length === 0) {
    return (
      <div className="flex items-center justify-between gap-3 p-3">
        <p className="text-destructive text-sm">{error}</p>
        <Button variant="outline" size="xs" onClick={refresh}>
          Retry
        </Button>
      </div>
    );
  }
  if (groups.length === 0) {
    return (
      <p className="text-muted-foreground p-3 text-sm">
        No repositories are visible to this token.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Input
          inputSize="sm"
          placeholder="Filter organizations and repositories…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <Button variant="ghost" size="xs" onClick={refresh}>
          Refresh
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-1">
        <Button
          variant={ownerFilter == null ? 'secondary' : 'ghost'}
          size="xs"
          className={ownerFilter == null ? undefined : 'text-muted-foreground'}
          onClick={() => setOwnerFilter(null)}
        >
          All
        </Button>
        {groups.map((group) => (
          <OwnerChip
            key={group.owner.login}
            owner={group.owner}
            selected={ownerFilter === group.owner.login}
            onToggle={() =>
              setOwnerFilter((current) =>
                current === group.owner.login ? null : group.owner.login
              )
            }
          />
        ))}
      </div>
      {visible.length === 0 ? (
        <p className="text-muted-foreground p-3 text-sm">
          No repositories match.
        </p>
      ) : (
        visible.map((group) => (
          <RepoGroupCard
            key={group.owner.login}
            group={group}
            selectedRepo={selectedRepo}
            onSelectRepo={onSelectRepo}
          />
        ))
      )}
      {hasMore && (
        <div className="flex items-center justify-between gap-3 rounded-md border border-dashed px-3 py-2">
          <p className="text-muted-foreground text-xs">
            {query.trim() === ''
              ? 'More repositories are available.'
              : 'Search currently covers the repositories loaded so far.'}
          </p>
          <Button
            variant="outline"
            size="xs"
            disabled={loadingMore}
            onClick={loadMore}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {error != null && groups.length > 0 && (
        <p className="text-destructive px-3 text-xs">{error}</p>
      )}
    </div>
  );
}

function OwnerChip({
  onToggle,
  owner,
  selected,
}: {
  onToggle(): void;
  owner: RepoDirectoryOwner;
  selected: boolean;
}) {
  return (
    <Button
      variant={selected ? 'secondary' : 'ghost'}
      size="xs"
      className={cn('gap-1.5', selected ? undefined : 'text-muted-foreground')}
      aria-pressed={selected}
      onClick={onToggle}
    >
      <OwnerAvatar owner={owner} className="size-3.5" />
      {owner.login}
    </Button>
  );
}

// The owner's avatar (orgs resolve through the same /users/{login} profile
// fallback as user avatars) with an icon stand-in while nothing has loaded.
function OwnerAvatar({
  className,
  owner,
}: {
  className?: string;
  owner: RepoDirectoryOwner;
}) {
  if (owner.avatarUrl == null || owner.avatarUrl === '') {
    const Icon = owner.kind === 'org' ? IconBuilding : IconPerson;
    return <Icon className={cn('text-muted-foreground', className)} />;
  }
  return (
    <CommentAuthorAvatar
      author={{ avatarUrl: owner.avatarUrl, login: owner.login }}
      className={cn('self-center', className)}
    />
  );
}

function RepoGroupCard({
  group,
  onSelectRepo,
  selectedRepo,
}: {
  group: RepoDirectoryGroup;
  onSelectRepo(fullName: string): void;
  selectedRepo: string | null | undefined;
}) {
  return (
    <section className={SECTION_CARD_CLASS}>
      <h4 className="flex items-center gap-2 border-b px-3 py-2 text-sm font-medium">
        <OwnerAvatar owner={group.owner} className="size-4" />
        <span className="min-w-0 flex-1 truncate">{group.owner.login}</span>
        <span className="text-muted-foreground text-xs font-normal">
          {group.repos.length === 1
            ? '1 repository'
            : `${group.repos.length} repositories`}
        </span>
      </h4>
      {group.repos.length === 0 ? (
        <p className="text-muted-foreground p-3 text-sm">
          No repositories from this organization are loaded yet.
        </p>
      ) : (
        group.repos.map((repo) => (
          <RepoRow
            key={repo.fullName}
            repo={repo}
            selected={repo.fullName === selectedRepo}
            onSelect={() => onSelectRepo(repo.fullName)}
          />
        ))
      )}
    </section>
  );
}

function RepoRow({
  onSelect,
  repo,
  selected,
}: {
  onSelect(): void;
  repo: RepoDirectoryRepo;
  selected: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'hover:bg-accent/50 flex w-full cursor-pointer items-center gap-2 border-b px-3 py-1.5 text-left last:border-b-0',
        selected && 'bg-accent/60'
      )}
      onClick={onSelect}
    >
      <span className="min-w-0 flex-1 truncate font-mono text-[13px]">
        {repo.name}
      </span>
      {repo.archived && (
        <span className="text-muted-foreground rounded-md border px-1.5 py-0.5 text-[11px]">
          archived
        </span>
      )}
      {repo.private && (
        <IconLock
          aria-label="Private repository"
          className="text-muted-foreground size-3.5"
        />
      )}
    </button>
  );
}
