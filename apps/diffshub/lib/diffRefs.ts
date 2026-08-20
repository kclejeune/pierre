import type { PullRefs } from './githubCommitServer';
import {
  type GitHubDiffSource,
  type GitHubRepo,
  isSameGitHubRepo,
} from './githubDiffSource';
import type { PullInfo } from './pullInfoClient';
import {
  buildBrowseTreePath,
  buildDiffHeadTreePath,
  isForkQualifiedRef,
  splitCompareRange,
} from './repoBrowser';

// One end of the comparison the viewer shows. `label` is what GitHub calls
// the ref (fork heads keep GitHub's `owner:branch` spelling), which is also
// the spelling its `base...head` compare grammar accepts — the header's ref
// pickers splice it into new compare ranges when the user swaps the other
// side. `browsePath` is the app's file browser at that ref, or null when the
// ref lives in another repository the browser cannot resolve (fork compare
// heads).
export interface DiffRefEnd {
  browsePath: string | null;
  label: string;
}

export interface DiffRefs {
  // Null when the source names only a head (a bare `compare/<ref>` range,
  // which GitHub compares against the default branch).
  base: DiffRefEnd | null;
  head: DiffRefEnd;
  // The repository the comparison lives in, so the header's ref pickers can
  // list its branches and build compare paths.
  repo: GitHubRepo;
}

// The base/head pair a diff source compares, for the header's branch
// display. Compare ranges name both ends in the URL; pull requests only carry
// a number, so their branches come from the pull payload (`pullInfo`) once
// it has loaded. Single commits have no meaningful base/head pair.
export function describeDiffRefs(
  source: GitHubDiffSource,
  pullInfo: PullInfo | null
): DiffRefs | null {
  switch (source.kind) {
    case 'commit':
      return null;
    case 'compare': {
      const { base, head } = splitCompareRange(source.range);
      if (head === '') {
        return null;
      }
      return {
        base: base == null ? null : describeCompareEnd(source, base),
        head: {
          browsePath: buildDiffHeadTreePath(source),
          label: head,
        },
        repo: source.repo,
      };
    }
    case 'pull': {
      if (pullInfo == null || pullInfo.number !== source.number) {
        return null;
      }
      return {
        base: {
          browsePath: buildBrowseTreePath(source.repo, pullInfo.baseRef),
          label: pullInfo.baseRef,
        },
        head: {
          // Every pull advertises refs/pull/N/head in the base repo, so the
          // head browses there even when the branch itself lives in a fork.
          browsePath: buildDiffHeadTreePath(source),
          label: formatPullHeadLabel(pullInfo),
        },
        repo: source.repo,
      };
    }
  }
}

function describeCompareEnd(
  source: Extract<GitHubDiffSource, { kind: 'compare' }>,
  ref: string
): DiffRefEnd {
  return {
    browsePath: isForkQualifiedRef(ref)
      ? null
      : buildBrowseTreePath(source.repo, ref),
    label: ref,
  };
}

// GitHub's own spelling of a pull head: the bare branch for same-repo pulls,
// `owner:branch` when the head lives in a fork.
function formatPullHeadLabel(refs: PullRefs): string {
  return isSameGitHubRepo(refs.headRepo, refs.baseRepo)
    ? refs.headRef
    : `${refs.headRepo.owner}:${refs.headRef}`;
}

// The header's committed value for the URL input: the shortest string
// `getPatchViewerHref` round-trips back to this source, so the hostname (which
// the header shows separately) and the `/pull/` boilerplate stay out of the
// field until the user edits it. Pulls use GitHub's `owner/repo#N` shorthand;
// commits and compares keep their path form since that is their shorthand.
export function formatDiffSourceShorthand(source: GitHubDiffSource): string {
  const repo = `${source.repo.owner}/${source.repo.repo}`;
  switch (source.kind) {
    case 'pull':
      return `${repo}#${source.number}`;
    case 'commit':
      return `${repo}/commit/${source.sha}`;
    case 'compare':
      return `${repo}/compare/${source.range}`;
  }
}
