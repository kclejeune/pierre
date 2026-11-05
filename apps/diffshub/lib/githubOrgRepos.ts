// Organization repository listings for the /pulls repo switcher's search,
// cached once per organization for every viewer, with access checked per
// viewer before any name is returned.
//
// Why shared: re-listing a large org (thousands of repos, 100 per request)
// for each viewer is too expensive, and repo lists change slowly. The
// listing is built with whichever viewer's token first needs it, so it holds
// what that viewer can see; a viewer with narrower access would otherwise
// learn names they can't read.
//
// Authorization: names from a listing only leave the server through
// filterAccessibleRepos, and every one (public repos included, since
// visibility can change after the listing is built) passes only after a
// GraphQL `repository` lookup with the caller's own token resolves: one
// batched request per search, remembered per credential for ACCESS_TTL_MS.
// The listing itself never reaches the browser.
//
// Storage: the GitHub cache store (lib/githubCacheStore) through
// lib/githubCacheCodec, so org and repo names never appear in the store in
// plain text, plus a process-local copy so a burst of keystrokes reads the
// store once. Any store failure degrades to "no listing yet": search returns
// nothing from that org rather than failing.

import { createLimitedFetch } from './concurrencyLimit';
import { rankPathMatches } from './fileSearchFilter';
import {
  type CacheContext,
  readCacheEntry,
  writeCacheEntry,
} from './githubCacheCodec';
import { getGitHubCacheLimits, getGitHubCacheStore } from './githubCacheStore';
import { fetchGitHubJSON, sendGitHubGraphQL } from './githubCommitServer';
import { encodeURLSegment } from './githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  getTokenEncryptionKey,
} from './githubEnvironment';
import { githubFetch } from './githubFetch';
import { parseLastPage } from './githubPagination';
import { parseGitHubJSONBody } from './githubProxyResponse';
import { getCurrentRouteLabel } from './requestLog';
import { emitLogLine, formatError, logUpstreamFailure } from './serverLog';
import { createAsyncLRU, credentialCacheScope } from './serverLRU';
import { asRecord } from './untypedJson';

export interface OrgRepoListing {
  // When the listing was fetched from GitHub (ms since epoch).
  builtAt: number;
  // "org/name" for every non-archived repository, most recently pushed
  // first. One array per listing, so the matcher's lowercase cache (keyed by
  // array identity) is reused across searches.
  fullNames: string[];
  // The same repos without the "org/" prefix, index for index, matched when
  // a query's owner part has already picked the org.
  names: string[];
  org: string;
}

// Stored this long; the listing is rebuilt in the background once it's
// older than REFRESH_AFTER_MS, so readers always have one to search while a
// fresh copy is fetched.
const LISTING_STORE_TTL_SECONDS = 14 * 86_400;
const REFRESH_AFTER_MS = 3 * 86_400_000;
// Process-local copy of a listing read from the store. Misses aren't kept,
// so a listing another process just stored is found on the next search.
const LISTING_MEMORY_TTL_MS = 10 * 60_000;
// After a failed rebuild (SSO-blocked token, GitHub outage), how long this
// process waits before trying that org again, so each keystroke doesn't
// start another.
const REFRESH_FAILURE_BACKOFF_MS = 10 * 60_000;
// How long a viewer's resolved access to a repo is trusted.
const ACCESS_TTL_MS = 60 * 60_000;
// GitHub serves 100 repos per page; past this many pages (20k repos) the
// listing is too large to cache usefully.
const REPO_PAGE_SIZE = 100;
const MAX_REPO_PAGES = 200;
const LISTING_FETCH_CONCURRENCY = 6;
// The viewer's org memberships: short-lived, since leaving an org should
// stop that org's search soon.
const VIEWER_ORGS_TTL_MS = 5 * 60_000;
// Approximate retained bytes per listed repo: its full and bare names, the
// matcher's lowercase copy of each, and array slots.
const BYTES_PER_LISTED_NAME = 320;

const listingMemory = createAsyncLRU<string, OrgRepoListing>({
  maxEntries: 200,
  // Well under a Workers isolate's 128 MB.
  maxWeight: 32 * 1024 * 1024,
  ttlMs: LISTING_MEMORY_TTL_MS,
  weight: (listing) => listing.fullNames.length * BYTES_PER_LISTED_NAME,
});

const accessMemory = createAsyncLRU<string, boolean>({
  maxEntries: 50_000,
  ttlMs: ACCESS_TTL_MS,
});

const viewerOrgsMemory = createAsyncLRU<string, string[]>({
  maxEntries: 1000,
  ttlMs: VIEWER_ORGS_TTL_MS,
});

const refreshFailures = createAsyncLRU<string, true>({
  maxEntries: 1000,
  ttlMs: REFRESH_FAILURE_BACKOFF_MS,
});

// Rebuilds in flight in this process, so a burst of searches against a
// stale org starts one rebuild.
const refreshesInFlight = new Map<string, Promise<void>>();

function listingKey(org: string): string {
  return `org-repos:v1:${getGitHubEnvironment().apiURL}:${org.toLowerCase()}`;
}

// The stored form: repo names without the org prefix.
interface StoredListing {
  builtAt: number;
  names: string[];
}

function isStoredListing(value: unknown): value is StoredListing {
  const record = asRecord(value);
  return typeof record?.builtAt === 'number' && Array.isArray(record.names);
}

function toListing(org: string, stored: StoredListing): OrgRepoListing {
  return {
    builtAt: stored.builtAt,
    fullNames: stored.names.map((name) => `${org}/${name}`),
    names: stored.names,
    org,
  };
}

function logListingError(error: unknown): void {
  emitLogLine({
    error: formatError(error),
    event: 'github_org_repos_error',
    level: 'warn',
  });
}

// The store and its settings, or null when no durable cache is configured.
async function cacheContext(): Promise<CacheContext | null> {
  const limits = getGitHubCacheLimits();
  const store = limits == null ? undefined : await getGitHubCacheStore();
  return limits == null || store == null
    ? null
    : { encryptionKey: getTokenEncryptionKey(), limits, store };
}

// The stored listing for `org`, straight from the store.
async function readStoredListing(org: string): Promise<OrgRepoListing | null> {
  const context = await cacheContext();
  if (context == null) {
    return null;
  }
  const value = await readCacheEntry(context, listingKey(org));
  return isStoredListing(value) ? toListing(org, value) : null;
}

// The cached listing for `org`, or null when none has been built (or the
// store can't be read). Never calls GitHub.
export async function loadOrgListing(
  org: string
): Promise<OrgRepoListing | null> {
  const logical = listingKey(org);
  const remembered = listingMemory.peek(logical);
  if (remembered != null) {
    return remembered;
  }
  const stored = await readStoredListing(org).catch((error: unknown) => {
    logListingError(error);
    return null;
  });
  if (stored != null) {
    listingMemory.set(logical, stored);
  }
  return stored;
}

export function listingNeedsRefresh(listing: OrgRepoListing | null): boolean {
  return listing == null || Date.now() - listing.builtAt > REFRESH_AFTER_MS;
}

// One page of /orgs/{org}/repos reduced to what the listing keeps, as soon
// as it arrives: full repository objects run ~5 KB each, so holding every
// page of a large org until the end would cost tens of MB.
async function fetchRepoPage(
  org: string,
  page: number,
  token: string,
  fetcher: typeof githubFetch
): Promise<{ lastPage: number; names: string[] }> {
  const url = createGitHubAPIURL(
    getGitHubEnvironment(),
    `/orgs/${encodeURLSegment(org)}/repos`,
    {
      direction: 'desc',
      page: String(page),
      per_page: String(REPO_PAGE_SIZE),
      sort: 'pushed',
      type: 'all',
    }
  );
  const response = await fetcher(url, {
    cache: 'no-store',
    headers: createGitHubJSONHeaders(token),
  });
  if (!response.ok) {
    logUpstreamFailure({
      credential: 'viewer',
      error: `listing ${org} repositories`,
      response,
      route: getCurrentRouteLabel('unknown'),
      upstreamURL: url,
    });
    throw new Error(`GitHub answered ${response.status} listing ${org}.`);
  }
  const body = await parseGitHubJSONBody(response);
  if (body.problem != null) {
    throw new Error(body.problem);
  }
  const names: string[] = [];
  for (const item of Array.isArray(body.data) ? body.data : []) {
    const repo = asRecord(item);
    if (typeof repo?.name === 'string' && repo.archived !== true) {
      names.push(repo.name);
    }
  }
  return { lastPage: parseLastPage(response.headers.get('link')), names };
}

// Lists every repository `token` can see in `org`: page one first (its Link
// header says how many pages there are), then the rest in parallel. Throws
// on any failed page, so a partial listing is never cached.
async function fetchOrgRepos(
  org: string,
  token: string
): Promise<StoredListing> {
  const fetcher = createLimitedFetch(LISTING_FETCH_CONCURRENCY, githubFetch);
  const first = await fetchRepoPage(org, 1, token, fetcher);
  const lastPage = Math.min(first.lastPage, MAX_REPO_PAGES);
  const rest = await Promise.all(
    Array.from({ length: lastPage - 1 }, (_, index) =>
      fetchRepoPage(org, index + 2, token, fetcher)
    )
  );
  const pages = [first, ...rest];
  return {
    builtAt: Date.now(),
    names: pages.flatMap((page) => page.names),
  };
}

// Rebuilds `org`'s listing with `token` and stores it, unless another
// process already stored a fresh one (checked first, since each server
// process sees a listing go stale on its own) or a recent rebuild failed.
// Concurrent calls in this process share one rebuild. Failures are logged
// and leave the old listing in place; meant to run after the response
// (Next's `after`).
export function refreshOrgListing(org: string, token: string): Promise<void> {
  const logical = listingKey(org);
  const inFlight = refreshesInFlight.get(logical);
  if (inFlight != null) {
    return inFlight;
  }
  if (refreshFailures.has(logical)) {
    return Promise.resolve();
  }
  const refresh = (async () => {
    try {
      const stored = await readStoredListing(org).catch(() => null);
      if (stored != null && !listingNeedsRefresh(stored)) {
        listingMemory.set(logical, stored);
        return;
      }
      const fetched = await fetchOrgRepos(org, token);
      // Seeds this process right away, even when nothing durable is
      // configured.
      listingMemory.set(logical, toListing(org, fetched));
      const context = await cacheContext();
      if (context != null) {
        await writeCacheEntry(
          context,
          logical,
          fetched,
          LISTING_STORE_TTL_SECONDS
        );
      }
    } catch (error) {
      refreshFailures.set(logical, true);
      logListingError(error);
    } finally {
      refreshesInFlight.delete(logical);
    }
  })();
  refreshesInFlight.set(logical, refresh);
  return refresh;
}

// The logins of the orgs `token`'s user belongs to. Outside collaborators
// aren't members, so their orgs are never searched.
export function loadViewerOrgs(token: string): Promise<string[]> {
  return viewerOrgsMemory.getOrCreate(credentialCacheScope(token), async () => {
    const payload = await fetchGitHubJSON('/user/orgs?per_page=100', token);
    return (Array.isArray(payload) ? payload : [])
      .map((item) => asRecord(item)?.login)
      .filter((login): login is string => typeof login === 'string');
  });
}

// One aliased `repository` lookup per name; a null field (with a NOT_FOUND
// error) means the token can't see it.
async function checkAccess(
  fullNames: readonly string[],
  token: string
): Promise<boolean[]> {
  const params: string[] = [];
  const fields: string[] = [];
  const variables: Record<string, string> = {};
  fullNames.forEach((fullName, index) => {
    const [owner, name] = fullName.split('/') as [string, string];
    params.push(`$o${index}: String!, $n${index}: String!`);
    fields.push(
      `r${index}: repository(owner: $o${index}, name: $n${index}) { id }`
    );
    variables[`o${index}`] = owner;
    variables[`n${index}`] = name;
  });
  const data = asRecord(
    await sendGitHubGraphQL(
      `query (${params.join(', ')}) { ${fields.join(' ')} }`,
      variables,
      token,
      githubFetch,
      { allowNotFound: true }
    )
  );
  return fullNames.map((_, index) => asRecord(data?.[`r${index}`]) != null);
}

// `candidates` (in order) narrowed to the ones `token` can read, by a
// remembered or live access check. Unknown candidates are checked in one
// batched request.
export async function filterAccessibleRepos(
  candidates: readonly string[],
  token: string
): Promise<string[]> {
  const scope = credentialCacheScope(token);
  const accessKey = (fullName: string) => `${scope}:${fullName.toLowerCase()}`;
  const access = new Map<string, boolean>();
  const unknown: string[] = [];
  for (const fullName of candidates) {
    const known = accessMemory.peek(accessKey(fullName));
    if (known == null) {
      unknown.push(fullName);
    } else {
      access.set(fullName, known);
    }
  }
  if (unknown.length > 0) {
    const results = await checkAccess(unknown, token);
    unknown.forEach((fullName, index) => {
      accessMemory.set(accessKey(fullName), results[index]);
      access.set(fullName, results[index]);
    });
  }
  return candidates.filter((fullName) => access.get(fullName) === true);
}

// A switcher query split for the two-pass search: "owner/name" narrows to
// orgs whose login contains the owner part, then matches the name part;
// anything else matches whole "org/name" paths.
export interface OrgRepoQuery {
  namePart: string;
  ownerPart: string;
  query: string;
}

export function parseOrgRepoQuery(query: string): OrgRepoQuery {
  const slash = query.indexOf('/');
  return slash < 0
    ? { namePart: query, ownerPart: '', query }
    : {
        namePart: query.slice(slash + 1),
        ownerPart: query.slice(0, slash).toLowerCase(),
        query,
      };
}

export function narrowOrgs(
  orgs: readonly string[],
  parsed: OrgRepoQuery
): string[] {
  return parsed.ownerPart === ''
    ? [...orgs]
    : orgs.filter((org) => org.toLowerCase().includes(parsed.ownerPart));
}

// The top `limit` candidates across `listings`, ranked per listing (each
// listing's own arrays key the matcher's lowercase cache, so that cache is
// released with the listing) and merged. With an owner part the orgs
// are already narrowed, so only bare repo names are matched (a bare owner
// lists each org's most recently pushed repos) and mapped back to full
// names; otherwise whole "org/name" paths are, which lets the matcher prefer
// name hits over owner hits.
export function rankOrgRepos(
  listings: readonly OrgRepoListing[],
  parsed: OrgRepoQuery,
  limit: number
): string[] {
  if (parsed.ownerPart !== '' && parsed.namePart.trim() === '') {
    return listings
      .flatMap((listing) => listing.fullNames.slice(0, limit))
      .slice(0, limit);
  }
  const byName = parsed.ownerPart !== '';
  const query = byName ? parsed.namePart : parsed.query;
  const matches = listings.flatMap((listing, order) => {
    const searched = byName ? listing.names : listing.fullNames;
    return rankPathMatches(searched, query, limit).map((match) => ({
      ...match,
      fullName: listing.fullNames[match.index],
      order,
      searched: searched[match.index],
    }));
  });
  // The order one ranking over every listing's names, concatenated, would
  // give: score, then localeCompare, then position.
  matches.sort((a, b) => {
    if (a.score !== b.score) {
      return b.score - a.score;
    }
    const byText = a.searched.localeCompare(b.searched);
    if (byText !== 0) {
      return byText;
    }
    return a.order === b.order ? a.index - b.index : a.order - b.order;
  });
  return matches.slice(0, limit).map((match) => match.fullName);
}
