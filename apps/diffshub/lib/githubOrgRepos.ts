// Organization repository listings for the command palette's repo search,
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
// nothing from that org rather than failing. Without a durable store, the
// process-local copy of a listing this process built is kept as long as the
// store would have kept it.

import { createLimitedFetch } from './concurrencyLimit';
import { compareRankedPaths, rankPathMatches } from './fileSearchFilter';
import { cacheEntry } from './githubCacheCodec';
import { getGitHubCacheLimits, getGitHubCacheStore } from './githubCacheStore';
import { sendGitHubGraphQL } from './githubCommitServer';
import { encodeURLSegment } from './githubDiffSource';
import {
  createGitHubAPIURL,
  createGitHubJSONHeaders,
  getGitHubEnvironment,
  getTokenEncryptionKey,
} from './githubEnvironment';
import { githubFetch } from './githubFetch';
import {
  fetchAllGitHubPages,
  fetchPagesInParallel,
  parseLastPage,
} from './githubPagination';
import {
  describeGitHubFailureBody,
  parseGitHubJSONBody,
} from './githubProxyResponse';
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

// How many listings one process keeps in memory, which also caps the orgs
// one search covers: past it, listings would evict each other on every
// search. (The size budget can evict sooner for orgs with thousands of
// repos.)
const MAX_LISTINGS_IN_MEMORY = 200;

const listingMemory = createAsyncLRU<string, OrgRepoListing>({
  maxEntries: MAX_LISTINGS_IN_MEMORY,
  // Well under a Workers isolate's 128 MB.
  maxWeight: 32 * 1024 * 1024,
  ttlMs: LISTING_MEMORY_TTL_MS,
  weight: (listing) => listing.fullNames.length * BYTES_PER_LISTED_NAME,
});

// Every listing rebuild in this process shares one concurrency limit, so a
// viewer in many stale orgs, or several viewers, fetch
// LISTING_FETCH_CONCURRENCY pages at a time in total (each ~500 KB of JSON)
// rather than per org or per search.
const listingFetch = createLimitedFetch(LISTING_FETCH_CONCURRENCY, githubFetch);

const accessMemory = createAsyncLRU<string, boolean>({
  maxEntries: 50_000,
  ttlMs: ACCESS_TTL_MS,
});

const viewerOrgsMemory = createAsyncLRU<string, string[]>({
  maxEntries: 1000,
  ttlMs: VIEWER_ORGS_TTL_MS,
});

// Rebuilds started in this process, kept REFRESH_FAILURE_BACKOFF_MS after
// they settle: a burst of searches against a stale org shares one rebuild,
// and a failed one (SSO-blocked token, GitHub outage) isn't retried on every
// keystroke. A successful one leaves a fresh listing, so holding it changes
// nothing.
const refreshes = createAsyncLRU<string, void>({
  maxEntries: 1000,
  ttlMs: REFRESH_FAILURE_BACKOFF_MS,
});

// Thrown by a listing read that finds nothing, so the LRU drops the miss
// instead of caching it.
class ListingMiss extends Error {}

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
  };
}

function logListingError(error: unknown): void {
  emitLogLine({
    error: formatError(error),
    event: 'github_org_repos_error',
    level: 'warn',
  });
}

// The store entry for `org`'s listing, or null when no durable cache is
// configured.
async function listingEntry(org: string) {
  const limits = getGitHubCacheLimits();
  const store = limits == null ? undefined : await getGitHubCacheStore();
  return limits == null || store == null
    ? null
    : cacheEntry(
        { encryptionKey: getTokenEncryptionKey(), limits, store },
        listingKey(org)
      );
}

// The stored listing for `org`, straight from the store.
async function readStoredListing(org: string): Promise<OrgRepoListing | null> {
  const value = await (await listingEntry(org))?.read();
  return isStoredListing(value) ? toListing(org, value) : null;
}

// The cached listing for `org`, or null when none has been built (or the
// store can't be read). Never calls GitHub. Concurrent reads share one store
// read; misses aren't remembered, so a listing another process just stored
// is found on the next search.
export function loadOrgListing(org: string): Promise<OrgRepoListing | null> {
  return listingMemory
    .getOrCreate(listingKey(org), async () => {
      const stored = await readStoredListing(org);
      if (stored == null) {
        throw new ListingMiss();
      }
      return stored;
    })
    .catch((error: unknown) => {
      if (!(error instanceof ListingMiss)) {
        logListingError(error);
      }
      return null;
    });
}

function listingNeedsRefresh(listing: OrgRepoListing | null): boolean {
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
    const detail = describeGitHubFailureBody(
      await response.json().catch(() => null)
    );
    throw new Error(
      `GitHub answered ${response.status} listing ${org}${detail === '' ? '' : `: ${detail}`}.`
    );
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

// Lists every repository `token` can see in `org`. Throws on any failed
// page, so a partial listing is never cached.
async function fetchOrgRepos(
  org: string,
  token: string,
  fetcher: typeof githubFetch
): Promise<StoredListing> {
  const pages = await fetchPagesInParallel(
    (page) => fetchRepoPage(org, page, token, fetcher),
    (first) => first.lastPage,
    MAX_REPO_PAGES
  );
  return {
    builtAt: Date.now(),
    names: pages.flatMap((page) => page.names),
  };
}

// Rebuilds `org`'s listing with `token` and stores it, unless another
// process already stored a fresh one (checked first, since each server
// process sees a listing go stale on its own) or a recent rebuild failed.
// Concurrent calls in this process share one rebuild (see `refreshes`).
// Failures are logged and leave the old listing in place; meant to run
// after the response (Next's `after`).
export function refreshOrgListing(org: string, token: string): Promise<void> {
  const logical = listingKey(org);
  return refreshes.getOrCreate(logical, async () => {
    try {
      const stored = await readStoredListing(org).catch(() => null);
      if (stored != null && !listingNeedsRefresh(stored)) {
        listingMemory.set(logical, stored);
        return;
      }
      const fetched = await fetchOrgRepos(org, token, listingFetch);
      const entry = await listingEntry(org);
      // Seeds this process right away. The short process-local TTL only
      // exists to pick up listings other processes store; with caching on
      // but no durable store, this copy is the cache, so it lasts as long
      // as the store would have kept it.
      listingMemory.set(
        logical,
        toListing(org, fetched),
        entry == null && getGitHubCacheLimits() != null
          ? LISTING_STORE_TTL_SECONDS * 1000
          : undefined
      );
      await entry?.write(fetched, LISTING_STORE_TTL_SECONDS);
    } catch (error) {
      logListingError(error);
    }
  });
}

// Orgs one call to refreshOrgListings starts rebuilding. A viewer in many
// orgs with cold listings would otherwise download every org's pages (up to
// 200 of ~500 KB each) after a single keystroke; later searches pick up the
// rest.
const MAX_REFRESHES_PER_CALL = 30;

// Rebuilds up to MAX_REFRESHES_PER_CALL of `orgs`' listings (page fetches
// share the process-wide `listingFetch` limit). Orgs already rebuilding or
// backing off are skipped, so they don't hold the slots of orgs that still
// need a rebuild.
export function refreshOrgListings(
  orgs: readonly string[],
  token: string
): Promise<void> {
  return Promise.all(
    orgs
      .filter((org) => !refreshes.has(listingKey(org)))
      .slice(0, MAX_REFRESHES_PER_CALL)
      .map((org) => refreshOrgListing(org, token))
  ).then(() => undefined);
}

// The logins of the orgs `token`'s user belongs to. Outside collaborators
// aren't members, so their orgs are never searched. Every page is read, so
// a member of more than 100 orgs isn't cut off.
export function loadViewerOrgs(token: string): Promise<string[]> {
  return viewerOrgsMemory.getOrCreate(credentialCacheScope(token), async () => {
    const orgs = await fetchAllGitHubPages(
      (page) => `/user/orgs?per_page=100&page=${page}`,
      (payload) => (Array.isArray(payload) ? payload : null),
      token,
      githubFetch
    );
    return orgs
      .map((item) => asRecord(item)?.login)
      .filter((login): login is string => typeof login === 'string');
  });
}

// One aliased `repository` lookup per name; a null field means the token
// can't read it. GitHub explains a null field with a NOT_FOUND error, or a
// FORBIDDEN one when the repo's org blocks this token (SAML SSO it hasn't
// been authorized for, an IP allow list). Either is that one repo's answer,
// so neither fails the rest of the batch.
const ACCESS_FIELD_ERRORS: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'FORBIDDEN',
]);

async function checkAccess(
  fullNames: readonly string[],
  token: string,
  signal: AbortSignal | undefined
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
      (url, init) => githubFetch(url, { ...init, signal }),
      { allowedFieldErrors: ACCESS_FIELD_ERRORS }
    )
  );
  return fullNames.map((_, index) => asRecord(data?.[`r${index}`]) != null);
}

// `candidates` (in order) narrowed to the ones `token` can read, by a
// remembered or live access check. Unknown candidates are checked in one
// batched request, abandoned when `signal` aborts (a superseded keystroke).
export async function filterAccessibleRepos(
  candidates: readonly string[],
  token: string,
  signal?: AbortSignal
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
    const results = await checkAccess(unknown, token, signal);
    unknown.forEach((fullName, index) => {
      accessMemory.set(accessKey(fullName), results[index]);
      access.set(fullName, results[index]);
    });
  }
  return candidates.filter((fullName) => access.get(fullName) === true);
}

// A palette query split for the two-pass search: "owner/name" narrows to
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

// One ranked candidate, with what merging it against other listings' matches
// needs: the matcher's path and score, plus the listing's position (`order`)
// and the repo's position in it (`index`) for ties.
interface RankedCandidate {
  fullName: string;
  index: number;
  order: number;
  path: string;
  score: number;
}

// `listing`'s top `limit` candidates for `parsed`. With an owner part the
// orgs are already narrowed, so only bare repo names are matched (a bare
// owner lists each org's most recently pushed repos, in listing order) and
// mapped back to full names; otherwise whole "org/name" paths are, which
// lets the matcher prefer name hits over owner hits. Ranking per listing
// keys the matcher's lowercase cache by that listing's own arrays, so the
// cache is released with the listing.
function rankListing(
  listing: OrgRepoListing,
  order: number,
  parsed: OrgRepoQuery,
  limit: number
): RankedCandidate[] {
  if (parsed.ownerPart !== '' && parsed.namePart.trim() === '') {
    // Equal scores and paths, so merging keeps listing order.
    return listing.fullNames.slice(0, limit).map((fullName, index) => ({
      fullName,
      index,
      order,
      path: '',
      score: 0,
    }));
  }
  const byName = parsed.ownerPart !== '';
  const searched = byName ? listing.names : listing.fullNames;
  return rankPathMatches(
    searched,
    byName ? parsed.namePart : parsed.query,
    limit
  ).map((match) => ({
    ...match,
    fullName: listing.fullNames[match.index],
    order,
  }));
}

// Orders candidates the way one ranking over every listing's names,
// concatenated, would: the matcher's own order, then position.
function compareCandidates(a: RankedCandidate, b: RankedCandidate): number {
  const ranked = compareRankedPaths(a, b);
  if (ranked !== 0) {
    return ranked;
  }
  return a.order === b.order ? a.index - b.index : a.order - b.order;
}

// Merges one listing's ranked candidates (already in compareCandidates
// order) into `top`, a sorted window of at most `limit`. Stops at the first
// candidate that can't make the window, so a listing whose best match
// already loses costs one comparison.
function mergeIntoTop(
  top: RankedCandidate[],
  candidates: readonly RankedCandidate[],
  limit: number
): void {
  for (const candidate of candidates) {
    if (
      top.length >= limit &&
      compareCandidates(candidate, top[limit - 1]) >= 0
    ) {
      return;
    }
    let low = 0;
    let high = top.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (compareCandidates(top[middle], candidate) <= 0) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    top.splice(low, 0, candidate);
    if (top.length > limit) {
      top.pop();
    }
  }
}

// Listings one search loads at once. Each listing is ranked as soon as it
// loads and then dropped, keeping only the best candidates, so a viewer in
// many large orgs never has every decoded listing (and the matcher's
// lowercase copy of each) alive at the same time: the listing cache's size
// budget can't evict a listing a request still references.
const ORG_SEARCH_CONCURRENCY = 20;

export interface OrgListingSearch {
  // The top candidates, in rank order, not yet access-checked.
  candidates: string[];
  // Whether some org has no listing yet.
  pending: boolean;
  // Orgs whose listing is missing or due for a rebuild, in `orgs` order.
  stale: string[];
}

// Ranks the cached listings of `orgs` (the first MAX_LISTINGS_IN_MEMORY) for
// `parsed` and returns the top `limit`, in the order one ranking over all of
// them would give, however the loads interleave. Up to
// ORG_SEARCH_CONCURRENCY listings load at a time (see above). Stops early
// when `signal` aborts (a superseded keystroke). `load` is swappable for
// tests.
export async function searchOrgListings(
  orgs: readonly string[],
  parsed: OrgRepoQuery,
  limit: number,
  {
    load = loadOrgListing,
    signal,
  }: {
    load?: (org: string) => Promise<OrgRepoListing | null>;
    signal?: AbortSignal;
  } = {}
): Promise<OrgListingSearch> {
  const searched = orgs.slice(0, MAX_LISTINGS_IN_MEMORY);
  const top: RankedCandidate[] = [];
  const staleOrders: number[] = [];
  let pending = false;
  let next = 0;
  const worker = async () => {
    while (next < searched.length && signal?.aborted !== true) {
      const order = next;
      next += 1;
      const listing = await load(searched[order]);
      if (listingNeedsRefresh(listing)) {
        staleOrders.push(order);
      }
      if (listing == null) {
        pending = true;
      } else {
        mergeIntoTop(top, rankListing(listing, order, parsed, limit), limit);
      }
    }
  };
  await Promise.all(
    Array.from(
      { length: Math.min(ORG_SEARCH_CONCURRENCY, searched.length) },
      worker
    )
  );
  return {
    candidates: top.map((candidate) => candidate.fullName),
    pending,
    stale: staleOrders.sort((x, y) => x - y).map((order) => searched[order]),
  };
}
