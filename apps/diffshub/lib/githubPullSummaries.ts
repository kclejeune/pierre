// Normalizes GitHub pull request payloads into the row shape the /pulls
// dashboard renders. Two upstream shapes feed it: /search/issues items (the
// cross-repo "created / assigned / review requested" buckets, which carry the
// repo only as a repository_url) and /repos/{o}/{r}/pulls items (pinned-repo
// sections, where the caller already knows the repo).

export type PullBucket = 'created' | 'assigned' | 'review-requested';

export const PULL_BUCKETS: readonly PullBucket[] = [
  'created',
  'assigned',
  'review-requested',
];

export interface PullSummary {
  number: number;
  title: string;
  owner: string;
  repo: string;
  authorLogin?: string;
  authorAvatarUrl?: string;
  state: 'open' | 'draft';
  updatedAt: string;
  viewerPath: string;
}

export function isPullBucket(value: string): value is PullBucket {
  return (PULL_BUCKETS as readonly string[]).includes(value);
}

const BUCKET_QUALIFIERS: Record<PullBucket, string> = {
  created: 'author:@me',
  assigned: 'assignee:@me',
  'review-requested': 'review-requested:@me',
};

// Optionally scoped to a single "owner/name" repository, for pinned-repo
// cards that follow the dashboard's active bucket tab.
export function buildBucketSearchQuery(
  bucket: PullBucket,
  repo?: string
): string {
  const base = `is:open is:pr archived:false ${BUCKET_QUALIFIERS[bucket]}`;
  return repo == null ? base : `${base} repo:${repo}`;
}

// repository_url looks like https://api.github.com/repos/{owner}/{repo} on
// github.com and https://<host>/api/v3/repos/{owner}/{repo} on GHES; the two
// segments after "repos" identify the repository on both.
function parseRepositoryURL(
  value: unknown
): { owner: string; repo: string } | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  let segments: string[];
  try {
    segments = new URL(value).pathname.split('/').filter(Boolean);
  } catch {
    return undefined;
  }
  const reposIndex = segments.lastIndexOf('repos');
  const owner = segments[reposIndex + 1];
  const repo = segments[reposIndex + 2];
  if (reposIndex === -1 || owner == null || repo == null) {
    return undefined;
  }
  return { owner, repo };
}

function parsePullItem(
  value: unknown,
  repoRef?: { owner: string; repo: string }
): PullSummary | undefined {
  if (typeof value !== 'object' || value == null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const ref = repoRef ?? parseRepositoryURL(record.repository_url);
  if (
    ref == null ||
    typeof record.number !== 'number' ||
    typeof record.title !== 'string' ||
    typeof record.updated_at !== 'string'
  ) {
    return undefined;
  }
  const summary: PullSummary = {
    number: record.number,
    title: record.title,
    owner: ref.owner,
    repo: ref.repo,
    state: record.draft === true ? 'draft' : 'open',
    updatedAt: record.updated_at,
    viewerPath: `/${ref.owner}/${ref.repo}/pull/${record.number}`,
  };
  const user = record.user;
  if (typeof user === 'object' && user != null) {
    const { login, avatar_url: avatarUrl } = user as Record<string, unknown>;
    if (typeof login === 'string' && login !== '') {
      summary.authorLogin = login;
    }
    if (typeof avatarUrl === 'string' && avatarUrl !== '') {
      summary.authorAvatarUrl = avatarUrl;
    }
  }
  return summary;
}

export function parseSearchIssuesPayload(payload: unknown): {
  pulls: PullSummary[];
  totalCount: number;
} {
  if (typeof payload !== 'object' || payload == null) {
    return { pulls: [], totalCount: 0 };
  }
  const record = payload as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items : [];
  const pulls = items
    .map((item) => parsePullItem(item))
    .filter((pull): pull is PullSummary => pull != null);
  const totalCount =
    typeof record.total_count === 'number' ? record.total_count : pulls.length;
  return { pulls, totalCount };
}

export function parseRepoPullsPayload(
  owner: string,
  repo: string,
  payload: unknown
): PullSummary[] {
  if (!Array.isArray(payload)) {
    return [];
  }
  return payload
    .map((item) => parsePullItem(item, { owner, repo }))
    .filter((pull): pull is PullSummary => pull != null);
}
