import { IconFileTree, IconFolder, IconPin } from '@pierre/icons';

import { cn } from '@/lib/cn';
import type { PullScope } from '@/lib/pullScopes';
import { splitPath } from '@/lib/splitPath';

// An "owner/name" in the /pulls scope controls: owner quiet, name loud,
// because scanning a list of repositories is scanning names.
// `ownerClassName` lets a caller drop the owner where only the name fits
// (the query bar hides it on a narrow bar).
export function RepoName({
  ownerClassName,
  repo,
}: {
  ownerClassName?: string;
  repo: string;
}) {
  const { basename, dirname } = splitPath(repo);
  return (
    <span className="min-w-0 truncate font-mono text-[13px]">
      {dirname !== '' && (
        <span className={cn('text-muted-foreground', ownerClassName)}>
          {dirname}/
        </span>
      )}
      <span className="font-medium">{basename}</span>
    </span>
  );
}

// The icon each kind of scope wears in the bar's scope button.
export function ScopeIcon({
  className,
  scope,
}: {
  className?: string;
  scope: PullScope;
}) {
  switch (scope.kind) {
    case 'repo':
      return <IconFolder className={className} />;
    case 'pinned':
      return <IconPin className={className} />;
    case 'all':
      return <IconFileTree className={className} />;
  }
}
