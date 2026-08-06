import { getPatchViewerHref } from './getPatchViewerHref';
import type { RecentDiff } from './recentDiffs';

// Pure assembly of the command palette's sections from its data inputs, kept
// out of the component so ordering/grouping rules are unit-testable. The
// palette disables cmdk's built-in filtering (results are server-driven), so
// everything returned here is everything shown.

export interface PaletteItem {
  key: string;
  label: string;
  // Secondary text rendered after the label (path, relative time, hint).
  detail?: string;
  kind: 'recent' | 'repo' | 'pull' | 'open' | 'action';
  action:
    | { type: 'navigate'; path: string; recordTitle?: string }
    // Replaces the palette input, keeping it open — the progressive
    // owner/repo# flow used by repo results and pinned repos.
    | { type: 'fill'; value: string };
}

export interface PaletteSection {
  heading: string;
  items: PaletteItem[];
}

export interface BuildPaletteItemsInput {
  query: string;
  recents: readonly RecentDiff[];
  pinned: readonly string[];
  // Live results from the shared diff-URL suggestion loader for the query.
  suggestions: readonly { key: string; label: string; fill: string }[];
  githubHost?: string;
}

const MAX_RECENT_ITEMS = 8;

export function buildPaletteItems(
  input: BuildPaletteItemsInput
): PaletteSection[] {
  const query = input.query.trim();
  const sections: PaletteSection[] = [];

  if (query === '') {
    // Actions lead so the dashboard is the highlighted default — pressing
    // Enter on an empty palette goes to /pulls.
    sections.push({
      heading: 'Actions',
      items: [
        {
          key: 'action:pulls',
          label: 'Your pull requests',
          detail: 'Open the /pulls dashboard',
          kind: 'action',
          action: { type: 'navigate', path: '/pulls' },
        },
      ],
    });
    if (input.recents.length > 0) {
      sections.push({
        heading: 'Recent diffs',
        items: input.recents.slice(0, MAX_RECENT_ITEMS).map((recent) => ({
          key: `recent:${recent.path}`,
          label: recent.title ?? recent.path,
          detail: recent.title != null ? recent.path : undefined,
          kind: 'recent',
          action: { type: 'navigate', path: recent.path },
        })),
      });
    }
    if (input.pinned.length > 0) {
      sections.push({
        heading: 'Pinned repositories',
        items: input.pinned.map((repo) => ({
          key: `pinned:${repo}`,
          label: repo,
          detail: 'Browse open pull requests',
          kind: 'repo',
          action: { type: 'fill', value: `${repo}#` },
        })),
      });
    }
    return sections;
  }

  // A query that already resolves to a viewer path (pasted URL, bare path,
  // owner/repo#123 shorthand) gets a direct "open" item above the search
  // results. Suppress it while the input is still being narrowed toward a
  // pull request: a bare "owner/repo" prefix, or "owner/repo#text" where the
  // fragment is a title filter rather than a pull number.
  const directHref = getPatchViewerHref(query, input.githubHost);
  const isNarrowing =
    /^[^/\s]+\/[^/\s#]*$/.test(query) ||
    /^[^/\s]+\/[^/\s#]+#(?!\d+$)/.test(query);
  const openItems: PaletteItem[] =
    directHref != null && !isNarrowing
      ? [
          {
            key: `open:${directHref}`,
            label: `Open ${directHref}`,
            kind: 'open',
            action: { type: 'navigate', path: directHref },
          },
        ]
      : [];
  if (openItems.length > 0) {
    sections.push({ heading: 'Go to', items: openItems });
  }

  const repoItems: PaletteItem[] = [];
  const pullItems: PaletteItem[] = [];
  for (const suggestion of input.suggestions) {
    if (suggestion.key.startsWith('repo:')) {
      repoItems.push({
        key: suggestion.key,
        label: suggestion.label,
        detail: 'Browse open pull requests',
        kind: 'repo',
        action: { type: 'fill', value: suggestion.fill },
      });
    } else {
      const href = getPatchViewerHref(suggestion.fill, input.githubHost);
      if (href != null) {
        pullItems.push({
          key: suggestion.key,
          label: suggestion.label,
          kind: 'pull',
          action: {
            type: 'navigate',
            path: href,
            // "#123 · Title" → record the title into recents on selection.
            recordTitle: suggestion.label.replace(/^#\d+\s*·\s*/, ''),
          },
        });
      }
    }
  }
  if (pullItems.length > 0) {
    sections.push({ heading: 'Pull requests', items: pullItems });
  }
  if (repoItems.length > 0) {
    sections.push({ heading: 'Repositories', items: repoItems });
  }
  return sections;
}
