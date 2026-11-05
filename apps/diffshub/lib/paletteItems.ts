// The command palette's sections (cmd+K on every page), assembled from its
// data inputs so ranking and grouping stay unit-testable. The palette has two
// levels:
//
// - The top level: repositories (pins, recent repos, and the viewer's
//   directory ranked locally as you type, then fuzzy matches from the
//   viewer's organizations and GitHub's repository search below), recent
//   diffs, anything pasted that resolves to a view, the page's own scopes,
//   and commands.
// - One repository: its open pull requests, branches, and tags, plus direct
//   entries for a typed pull number, ref, or commit sha.
//
// The palette turns off cmdk's own filter, so everything returned here is
// everything shown.

import {
  filterPullSuggestions,
  type PullSuggestion,
} from './diffUrlSuggestions';
import { filterFilePathsForSearch } from './fileSearchFilter';
import { getPatchViewerHref } from './getPatchViewerHref';
import { isRepoPinned, isValidRepoName, splitRepoName } from './pinnedRepos';
import { buildPullsRepoPath } from './pullScopes';
import type { RecentDiff } from './recentDiffs';
import {
  buildBrowseRepoPath,
  buildBrowseTreePath,
  buildCommitDiffPath,
  formatBrowseRecentTitle,
  isCommitShaLike,
} from './repoBrowser';
import type { RepoRefsData } from './repoRefs';

export type PaletteIcon =
  | 'branch'
  | 'command'
  | 'commit'
  | 'open'
  | 'pull'
  | 'recent'
  | 'repo'
  | 'scope-all'
  | 'scope-pinned'
  | 'tag';

export type PaletteAction =
  | { type: 'navigate'; path: string; recordTitle?: string }
  // Picks a repository: the page's own handler when it has one (/pulls
  // scopes its list, /browse opens the repo's refs), otherwise the palette
  // steps into the repository.
  | { type: 'select-repo'; repo: string }
  // Runs an entry a page or the palette contributed (a /pulls scope, a
  // command), looked up by id.
  | { type: 'run'; id: string };

export interface PaletteItem {
  key: string;
  label: string;
  // Secondary text after the label.
  detail?: string;
  icon: PaletteIcon;
  // Set on repository rows, which can be pinned from the palette and
  // stepped into with Tab.
  repo?: string;
  action: PaletteAction;
}

export interface PaletteSection {
  heading: string;
  items: PaletteItem[];
}

// An entry contributed by a page or the palette itself, run by id. Commands
// match on their label and `keywords`.
export interface PaletteEntry {
  id: string;
  label: string;
  detail?: string;
  icon?: PaletteIcon;
  keywords?: string;
}

// Enough to fill the list without making the eye search through it.
const MAX_IDLE_DIRECTORY = 20;
export const MAX_REPO_MATCHES = 40;
const MAX_REMOTE = 8;
const MAX_IDLE_RECENT_DIFFS = 5;
const MAX_MATCHED_RECENT_DIFFS = 3;
const MAX_MATCHED_COMMANDS = 5;
const MAX_PULLS = 20;
const MAX_REFS = 20;

// A query starting with ">" lists only commands, the rest filtering them.
export const COMMAND_PREFIX = '>';

// --- Repository matching helpers -------------------------------------------

// The remote search terms for a query that could name a repository: a bare
// name (any character repository names allow), or "owner/" followed by part
// of a name. Null for anything else (spaces, URLs, "owner/repo#…").
const BARE_REPO_NAME = /^[A-Za-z0-9._-]+$/;
const OWNER_AND_NAME = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]*)$/;

export function deriveRepoSearchQuery(
  query: string
): { owner: string | null; query: string } | null {
  const trimmed = query.trim();
  if (BARE_REPO_NAME.test(trimmed)) {
    return { owner: null, query: trimmed };
  }
  const match = OWNER_AND_NAME.exec(trimmed);
  return match == null ? null : { owner: match[1], query: match[2] };
}

// The lowercase repo the "Go to" row offers for a typed complete
// "owner/name", or null when the query isn't one. Remote tiers skip it, since
// that row already shows it.
export function goToRepoKey(query: string): string | null {
  const trimmed = query.trim();
  return isValidRepoName(trimmed) ? trimmed.toLowerCase() : null;
}

// Whether a remote tier's `repo` would add a row: it isn't one the local
// sections know (`seen`, lowercase) or the "Go to" row for the typed name
// (`goTo`, from goToRepoKey). Shared by the sections and the palette's
// decision to skip GitHub search, so the two can't disagree.
export function isNewRemoteRepo(
  repo: string,
  seen: ReadonlySet<string>,
  goTo: string | null
): boolean {
  const key = repo.toLowerCase();
  return key !== goTo && !seen.has(key);
}

// The repos the palette knows locally (pins, then recents, then the
// directory), de-duplicated case-insensitively keeping first occurrences so
// a pinned repo's own casing wins over the directory's, plus their lowercase
// names for membership checks. It doesn't depend on the query, so callers
// keep one across keystrokes: the matcher caches lowercase paths by array
// identity, and the remote tiers check membership against `seen`.
export interface KnownRepos {
  repos: string[];
  seen: ReadonlySet<string>;
}

export function knownRepos(
  pinned: readonly string[],
  recents: readonly string[],
  directory: readonly string[]
): KnownRepos {
  const seen = new Set<string>();
  const repos: string[] = [];
  for (const list of [pinned, recents, directory]) {
    for (const repo of list) {
      const key = repo.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        repos.push(repo);
      }
    }
  }
  return { repos, seen };
}

// The known repos matching a typed query, best first. The go-to-file ranker
// treats "owner/name" as a path, so a hit in the repository name beats a hit
// in the owner, which beats a scattered subsequence ("dfhb" → diffshub).
// Exported so the palette can rank once per keystroke and decide from the
// count whether remote search is worth running.
export function matchKnownRepos(known: KnownRepos, query: string): string[] {
  return filterFilePathsForSearch(known.repos, query.trim(), MAX_REPO_MATCHES);
}

// "owner/repo#rest" or "owner/repo@rest": shorthand for stepping into a
// repository with `rest` as the query, its pull requests first after "#",
// its refs first after "@". Typing or pasting either form moves the palette
// into the repository, so "owner/repo#123" ends on that pull's "Open" row.
const REPO_SHORTHAND_PATTERN = /^([^/\s#@]+\/[^/\s#@]+)([#@])(.*)$/;

export function parseRepoShorthand(
  query: string
): { prefer: 'pulls' | 'refs'; repo: string; rest: string } | null {
  const match = REPO_SHORTHAND_PATTERN.exec(query.trimStart());
  if (match == null || !isValidRepoName(match[1])) {
    return null;
  }
  return {
    prefer: match[2] === '#' ? 'pulls' : 'refs',
    repo: match[1],
    rest: match[3].trim(),
  };
}

function repoItem(
  repo: string,
  detail?: string,
  action: PaletteAction = { type: 'select-repo', repo }
): PaletteItem {
  return {
    key: `repo:${repo.toLowerCase()}`,
    label: repo,
    detail,
    icon: 'repo',
    action,
    repo,
  };
}

function entryItem(entry: PaletteEntry): PaletteItem {
  return {
    key: `run:${entry.id}`,
    label: entry.label,
    detail: entry.detail,
    icon: entry.icon ?? 'command',
    action: { type: 'run', id: entry.id },
  };
}

// Appends a section unless it has nothing to show.
function pushSection(
  sections: PaletteSection[],
  heading: string,
  items: PaletteItem[]
): void {
  if (items.length > 0) {
    sections.push({ heading, items });
  }
}

// The "Commands" section for `commands`, when any.
function pushCommands(
  sections: PaletteSection[],
  commands: readonly PaletteEntry[]
): void {
  pushSection(sections, 'Commands', commands.map(entryItem));
}

// Commands whose label or keywords contain every word of `query`.
function matchCommands(
  commands: readonly PaletteEntry[],
  query: string
): PaletteEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  return commands.filter((command) => {
    const haystack = `${command.label} ${command.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

// The command-only list for a ">" query, or null for any other query.
function commandOnlySections(
  query: string,
  commands: readonly PaletteEntry[]
): PaletteSection[] | null {
  if (!query.startsWith(COMMAND_PREFIX)) {
    return null;
  }
  const sections: PaletteSection[] = [];
  pushCommands(sections, matchCommands(commands, query.slice(1)));
  return sections;
}

// The row for a pasted link, opening the view it resolved to.
function linkItem(path: string): PaletteItem {
  return {
    key: `open:${path}`,
    label: `Open ${path}`,
    icon: 'open',
    action: { type: 'navigate', path },
  };
}

function recentDiffItem(recent: RecentDiff): PaletteItem {
  return {
    key: `recent:${recent.path}`,
    label: recent.title ?? recent.path,
    detail: recent.title != null ? recent.path : undefined,
    icon: 'recent',
    action: { type: 'navigate', path: recent.path },
  };
}

// --- The top level ---------------------------------------------------------

export interface RootSectionsInput {
  query: string;
  pinned: readonly string[];
  recentRepos: readonly string[];
  recentDiffs: readonly RecentDiff[];
  // The viewer's repositories, most recently pushed first.
  directory: readonly string[];
  // knownRepos(pinned, recentRepos, directory), when the caller keeps one
  // across keystrokes; computed here otherwise.
  known?: KnownRepos;
  // matchKnownRepos(known, query), when the caller already ranked them.
  matches?: readonly string[];
  // Matches from the viewer's organizations (the org listing search),
  // already access-checked, possibly stale by a keystroke.
  orgMatches: readonly string[];
  // GitHub's repository-name search for the query, for repos outside the
  // viewer's orgs; possibly stale by a keystroke.
  remote: readonly string[];
  // The page's own top-level entries (the /pulls scopes), shown idle.
  scopes?: readonly PaletteEntry[];
  commands: readonly PaletteEntry[];
  githubHost?: string;
  // This app's host, so a pasted link to it opens in place.
  appHost?: string;
}

export function buildRootSections(input: RootSectionsInput): PaletteSection[] {
  const query = input.query.trim();
  const commandOnly = commandOnlySections(query, input.commands);
  if (commandOnly != null) {
    return commandOnly;
  }
  return query === '' ? idleRootSections(input) : typedRootSections(input);
}

function idleRootSections(input: RootSectionsInput): PaletteSection[] {
  const sections: PaletteSection[] = [];
  pushSection(sections, 'Scopes', (input.scopes ?? []).map(entryItem));
  pushSection(
    sections,
    'Pinned',
    input.pinned.map((repo) => repoItem(repo))
  );
  const recents = input.recentRepos.filter(
    (repo) => !isRepoPinned(input.pinned, repo)
  );
  pushSection(
    sections,
    'Recent repositories',
    recents.map((repo) => repoItem(repo))
  );
  pushSection(
    sections,
    'Recently viewed',
    input.recentDiffs.slice(0, MAX_IDLE_RECENT_DIFFS).map(recentDiffItem)
  );
  const shown = new Set(
    [...input.pinned, ...recents].map((repo) => repo.toLowerCase())
  );
  pushSection(
    sections,
    'Your repositories',
    input.directory
      .filter((repo) => !shown.has(repo.toLowerCase()))
      .slice(0, MAX_IDLE_DIRECTORY)
      .map((repo) => repoItem(repo))
  );
  pushCommands(sections, input.commands);
  return sections;
}

function typedRootSections(input: RootSectionsInput): PaletteSection[] {
  const query = input.query.trim();
  const sections: PaletteSection[] = [];

  // Anything pasted that already names a view (a GitHub pull, commit,
  // compare, tree, or file URL, a bare "owner/repo/pull/12" path, or a link
  // to this app) opens directly. A bare "owner/name" is a repository, which
  // the rows below offer instead.
  const directPath = isValidRepoName(query)
    ? undefined
    : getPatchViewerHref(query, input.githubHost, input.appHost);
  if (directPath != null) {
    pushSection(sections, 'Go to', [linkItem(directPath)]);
  }

  const known =
    input.known ?? knownRepos(input.pinned, input.recentRepos, input.directory);
  const matches = input.matches ?? matchKnownRepos(known, query);
  const goTo = goToRepoKey(query);
  // A complete "owner/name" that nothing loaded matches still deserves a
  // direct entry: it may be public, or outside the directory's first page.
  if (goTo != null && !isRepoPinned(matches, query)) {
    pushSection(sections, 'Go to', [repoItem(query, 'Repository')]);
  }
  pushSection(
    sections,
    'Repositories',
    matches.map((repo) =>
      repoItem(repo, isRepoPinned(input.pinned, repo) ? 'Pinned' : undefined)
    )
  );
  // Lowercase names a remote tier already added, so the next tier only adds
  // new repos (the org search caps its own results server-side).
  const added = new Set<string>();
  const takeNew = (repos: readonly string[], max = Infinity) => {
    const fresh: PaletteItem[] = [];
    for (const repo of repos) {
      const key = repo.toLowerCase();
      if (
        isNewRemoteRepo(repo, known.seen, goTo) &&
        !added.has(key) &&
        fresh.length < max
      ) {
        added.add(key);
        fresh.push(repoItem(repo));
      }
    }
    return fresh;
  };
  pushSection(sections, 'Your organizations', takeNew(input.orgMatches));
  pushSection(sections, 'More on GitHub', takeNew(input.remote, MAX_REMOTE));
  const needle = query.toLowerCase();
  pushSection(
    sections,
    'Recently viewed',
    input.recentDiffs
      .filter((recent) =>
        `${recent.title ?? ''} ${recent.path}`.toLowerCase().includes(needle)
      )
      .slice(0, MAX_MATCHED_RECENT_DIFFS)
      .map(recentDiffItem)
  );
  pushCommands(
    sections,
    matchCommands(input.commands, query).slice(0, MAX_MATCHED_COMMANDS)
  );
  return sections;
}

// --- One repository --------------------------------------------------------

export interface RepoSectionsInput {
  // "owner/name".
  repo: string;
  query: string;
  // The repository's open pull requests, or null while they load.
  pulls: readonly PullSuggestion[] | null;
  // Its branches and tags, or null while they load.
  refs: RepoRefsData | null;
  // Which list leads: pull requests on a pull's diff, refs in the file
  // browser and on other diffs.
  prefer: 'pulls' | 'refs';
  // Set after "owner/repo@": all-digit text (a numeric tag, an abbreviated
  // sha) is matched as a ref first, with "Open #N" offered after the refs
  // rather than instead of them. A leading "#" still means a pull.
  refsFirst?: boolean;
  // What the page is showing, marked "Current" in the lists.
  currentPull?: number;
  currentRef?: string;
  commands: readonly PaletteEntry[];
  githubHost?: string;
  // This app's host, so a pasted link to it opens in place.
  appHost?: string;
}

function pullPath(repo: string, number: number): string {
  return `/${repo}/pull/${number}`;
}

function refItem(
  repo: string,
  ref: string,
  kind: 'branch' | 'tag',
  detail?: string
): PaletteItem {
  const github = splitRepoName(repo);
  return {
    key: `${kind}:${ref}`,
    label: ref,
    detail,
    icon: kind,
    action: {
      type: 'navigate',
      path: buildBrowseTreePath(github, ref),
      recordTitle: formatBrowseRecentTitle(github, ref),
    },
  };
}

export function buildRepoSections(input: RepoSectionsInput): PaletteSection[] {
  const query = input.query.trim();
  const commandOnly = commandOnlySections(query, input.commands);
  if (commandOnly != null) {
    return commandOnly;
  }
  const sections: PaletteSection[] = [];
  // A pasted link opens what it names wherever the palette is, never as a
  // ref of this repository. Only text with a protocol counts here: ref
  // names can look like bare paths or dotted hosts ("release-1.2/hotfix").
  if (query.includes('://')) {
    const path = getPatchViewerHref(query, input.githubHost, input.appHost);
    if (path != null) {
      pushSection(sections, 'Go to', [linkItem(path)]);
    }
    return sections;
  }
  const github = splitRepoName(input.repo);
  const isListedRef =
    input.refs != null &&
    (input.refs.branches.includes(query) || input.refs.tags.includes(query));

  // A typed number opens that pull even when it's closed (the open list
  // can't show it); a sha-like query offers that commit. After "@", digits
  // are read as a ref first and the pull row moves below the refs.
  const goTo: PaletteItem[] = [];
  const digits = /^#?(\d+)$/.exec(query)?.[1];
  const openPull: PaletteItem | null =
    digits == null
      ? null
      : {
          key: `open-pull:${digits}`,
          label: `Open #${digits}`,
          detail: input.repo,
          icon: 'pull',
          action: {
            type: 'navigate',
            path: pullPath(input.repo, Number(digits)),
          },
        };
  // Whether the query is read as a pull number (and refs aren't matched).
  const pullLeads =
    openPull != null && !(input.refsFirst === true && !query.startsWith('#'));
  if (openPull != null && pullLeads) {
    goTo.push(openPull);
  } else if (isCommitShaLike(query) && !isListedRef) {
    goTo.push({
      key: `commit:${query}`,
      label: `View commit ${query}`,
      icon: 'commit',
      action: { type: 'navigate', path: buildCommitDiffPath(github, query) },
    });
  }
  pushSection(sections, 'Go to', goTo);

  const pullSection: PaletteSection = {
    heading: 'Open pull requests',
    items: filterPullSuggestions(input.pulls ?? [], digits ?? query)
      .slice(0, MAX_PULLS)
      .map(
        (pull): PaletteItem => ({
          key: `pull:${pull.number}`,
          label: `#${pull.number} · ${pull.title}`,
          detail: pull.number === input.currentPull ? 'Current' : undefined,
          icon: 'pull',
          action: {
            type: 'navigate',
            path: pullPath(input.repo, pull.number),
            recordTitle: pull.title,
          },
        })
      ),
  };

  // A number is a pull request; matching it against ref names only adds
  // noise (every tag with those digits in it).
  const refSections: PaletteSection[] = [];
  const { refs } = input;
  if (refs != null && !pullLeads) {
    const refDetail = (ref: string) =>
      ref === input.currentRef
        ? 'Current'
        : ref === refs.defaultBranch
          ? 'Default'
          : undefined;
    for (const [heading, names, kind] of [
      ['Branches', refs.branches, 'branch'],
      ['Tags', refs.tags, 'tag'],
    ] as const) {
      const matched =
        query === ''
          ? names.slice(0, MAX_REFS)
          : filterFilePathsForSearch(names, query, MAX_REFS);
      refSections.push({
        heading,
        items: matched.map((ref) =>
          refItem(input.repo, ref, kind, refDetail(ref))
        ),
      });
    }
  }

  const ordered =
    input.prefer === 'pulls'
      ? [pullSection, ...refSections]
      : [...refSections, pullSection];
  for (const section of ordered) {
    pushSection(sections, section.heading, section.items);
  }

  // Any other ref-shaped text still opens: the lists stop at their page size,
  // and refs/pull/… refs or shas aren't listed at all.
  if (query !== '' && !pullLeads && !/\s/.test(query) && !isListedRef) {
    pushSection(sections, 'Browse', [
      {
        ...refItem(input.repo, query, 'branch'),
        key: `browse-ref:${query}`,
        label: `Browse files at ${query}`,
      },
    ]);
  }
  // The pull a number names, when "@" put the refs first.
  if (openPull != null && !pullLeads) {
    pushSection(sections, 'Pull request', [openPull]);
  }

  if (query === '') {
    pushSection(sections, 'Repository', [
      {
        key: 'repo-browse',
        label: 'Browse files',
        detail: 'Default branch',
        icon: 'open',
        action: {
          type: 'navigate',
          path: buildBrowseRepoPath(github),
          recordTitle: formatBrowseRecentTitle(github, null),
        },
      },
      {
        key: 'repo-pulls',
        label: 'All pull requests',
        detail: 'On the pull request dashboard',
        icon: 'pull',
        action: {
          type: 'navigate',
          path: buildPullsRepoPath(input.repo),
        },
      },
    ]);
  } else {
    pushCommands(
      sections,
      matchCommands(input.commands, query).slice(0, MAX_MATCHED_COMMANDS)
    );
  }
  return sections;
}
