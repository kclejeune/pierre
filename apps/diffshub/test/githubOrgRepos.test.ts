import { afterEach, describe, expect, mock, test } from 'bun:test';
import * as nextServer from 'next/server';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/github-org-repo-search/route';
import {
  filterFilePathsForSearch,
  rankPathMatches,
} from '@/lib/fileSearchFilter';
import {
  filterAccessibleRepos,
  loadOrgListing,
  type OrgRepoListing,
  parseOrgRepoQuery,
  rankOrgRepos,
  refreshOrgListing,
} from '@/lib/githubOrgRepos';
import { createAsyncLRU } from '@/lib/serverLRU';

// `after` needs a Next request scope; tests run the deferred listing
// rebuild right away instead.
void mock.module('next/server', () => ({
  ...nextServer,
  after: (task: () => unknown) => void Promise.resolve().then(task),
}));

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const json = (payload: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json', ...headers },
  });

interface StubOptions {
  // org → pages of /orgs/{org}/repos items.
  orgPages?: Record<string, unknown[][]>;
  orgs?: string[];
  // "owner/name" the token can read through GraphQL `repository`.
  readable?: Set<string>;
}

// Stubs GitHub by request path and records each request, so tests can assert
// what was (and wasn't) fetched.
function stubGitHub({
  orgPages = {},
  orgs = [],
  readable = new Set(),
}: StubOptions) {
  const requests: string[] = [];
  globalThis.fetch = ((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api\/v3/, '');
    requests.push(path);
    if (path === '/user/orgs') {
      return Promise.resolve(json(orgs.map((login) => ({ login }))));
    }
    const orgMatch = /^\/orgs\/([^/]+)\/repos$/.exec(path);
    if (orgMatch != null) {
      const pages = orgPages[orgMatch[1]] ?? [[]];
      const page = Number(url.searchParams.get('page') ?? '1');
      const link =
        page === 1 && pages.length > 1
          ? {
              link: `<${url.origin}${url.pathname}?page=${pages.length}>; rel="last"`,
            }
          : undefined;
      return Promise.resolve(json(pages[page - 1] ?? [], link));
    }
    if (path === '/graphql') {
      const { variables } = JSON.parse(init?.body as string) as {
        variables: Record<string, string>;
      };
      const data: Record<string, unknown> = {};
      const errors: unknown[] = [];
      for (let index = 0; `o${index}` in variables; index += 1) {
        const fullName = `${variables[`o${index}`]}/${variables[`n${index}`]}`;
        if (readable.has(fullName)) {
          data[`r${index}`] = { id: `R_${index}` };
        } else {
          data[`r${index}`] = null;
          errors.push({ path: [`r${index}`], type: 'NOT_FOUND' });
        }
      }
      return Promise.resolve(
        json(errors.length > 0 ? { data, errors } : { data })
      );
    }
    return Promise.resolve(new Response('not stubbed', { status: 404 }));
  }) as typeof fetch;
  return requests;
}

const repo = (name: string, visibility: string, archived = false) => ({
  archived,
  name,
  private: visibility !== 'public',
  visibility,
});

describe('org listings', () => {
  test('lists every page and drops archived repos', async () => {
    const requests = stubGitHub({
      orgPages: {
        'listing-org': [
          [repo('alpha', 'internal'), repo('old', 'private', true)],
          [repo('beta', 'public')],
          [repo('gamma', 'private')],
        ],
      },
    });
    await refreshOrgListing('listing-org', 'token-listing');
    const listing = await loadOrgListing('listing-org');
    expect(listing?.fullNames).toEqual([
      'listing-org/alpha',
      'listing-org/beta',
      'listing-org/gamma',
    ]);
    expect(listing?.names).toEqual(['alpha', 'beta', 'gamma']);
    expect(requests.filter((path) => path.endsWith('/repos'))).toHaveLength(3);
  });

  test('a failed page leaves no partial listing behind', async () => {
    stubGitHub({
      orgPages: { 'flaky-org': [[repo('one', 'private')], [], []] },
    });
    const fetchOk = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) =>
      String(input).includes('page=3')
        ? new Response('boom', { status: 502 })
        : fetchOk(input as string, init)) as typeof fetch;
    await refreshOrgListing('flaky-org', 'token-flaky');
    expect(await loadOrgListing('flaky-org')).toBeNull();
    // Backs off: a search right after doesn't start another rebuild.
    const requests = stubGitHub({ orgPages: { 'flaky-org': [[]] } });
    await refreshOrgListing('flaky-org', 'token-flaky');
    expect(requests).toEqual([]);
  });
});

describe('filterAccessibleRepos', () => {
  test('checks every candidate once per credential', async () => {
    const requests = stubGitHub({
      readable: new Set(['acme/public', 'acme/private-ok']),
    });
    const candidates = [
      'acme/public',
      'acme/private-ok',
      'acme/private-hidden',
    ];
    const check = () => filterAccessibleRepos(candidates, 'token-access');
    expect(await check()).toEqual(['acme/public', 'acme/private-ok']);
    expect(requests).toEqual(['/graphql']);
    // Remembered: the second search makes no GitHub call.
    expect(await check()).toEqual(['acme/public', 'acme/private-ok']);
    expect(requests).toEqual(['/graphql']);
  });

  test('access is remembered per credential, not shared', async () => {
    stubGitHub({ readable: new Set(['acme/shared']) });
    expect(await filterAccessibleRepos(['acme/shared'], 'token-a')).toEqual([
      'acme/shared',
    ]);
    stubGitHub({ readable: new Set() });
    expect(await filterAccessibleRepos(['acme/shared'], 'token-b')).toEqual([]);
  });
});

describe('ranking', () => {
  const listing = (org: string, names: string[]) =>
    ({
      builtAt: Date.now(),
      fullNames: names.map((name) => `${org}/${name}`),
      names,
    }) satisfies OrgRepoListing;

  test('splits owner/name queries for the two-pass search', () => {
    expect(parseOrgRepoQuery('Anduril/lat')).toEqual({
      namePart: 'lat',
      ownerPart: 'anduril',
      query: 'Anduril/lat',
    });
    expect(parseOrgRepoQuery('lattice').ownerPart).toBe('');
  });

  test('ranks across orgs, and a bare owner lists recent repos', () => {
    const listings = [
      listing('acme', ['widgets', 'lattice-sdk']),
      listing('other', ['lattice', 'tools']),
    ];
    expect(rankOrgRepos(listings, parseOrgRepoQuery('lattice'), 5)).toEqual([
      'other/lattice',
      'acme/lattice-sdk',
    ]);
    expect(rankOrgRepos(listings, parseOrgRepoQuery('acme/'), 1)).toEqual([
      'acme/widgets',
    ]);
  });

  test('an owner part matches bare names, not the owner', () => {
    // Matching "ac" against whole paths would let "acme/" itself match.
    const listings = [listing('acme', ['tools', 'actions', 'docs'])];
    expect(rankOrgRepos(listings, parseOrgRepoQuery('acme/ac'), 5)).toEqual([
      'acme/actions',
    ]);
  });

  test('merging per-org rankings matches one ranking over every org', () => {
    const listings = [
      listing('acme', ['lattice', 'lat-tools', 'docs', 'atlas']),
      listing('beta', ['lattice', 'platform', 'tlat']),
      listing('gamma', ['latte', 'slate', 'lattice-sdk']),
    ];
    const all = listings.flatMap((each) => each.fullNames);
    const bare = listings.flatMap((each) => each.names);
    for (const limit of [1, 3, 20]) {
      for (const query of ['lat', 'at', 'a']) {
        expect(rankOrgRepos(listings, parseOrgRepoQuery(query), limit)).toEqual(
          filterFilePathsForSearch(all, query, limit)
        );
        // With an owner part, bare names are ranked as one list.
        expect(
          rankOrgRepos(listings, parseOrgRepoQuery(`a/${query}`), limit)
        ).toEqual(
          rankPathMatches(bare, query, limit).map((match) => all[match.index])
        );
      }
    }
  });

  test('maps bare-name matches back to the right org', () => {
    const listings = [
      listing('team-a', ['tools']),
      listing('team-b', ['tools', 'toolbox']),
    ];
    expect(rankOrgRepos(listings, parseOrgRepoQuery('team/tool'), 5)).toEqual([
      'team-a/tools',
      'team-b/tools',
      'team-b/toolbox',
    ]);
  });
});

describe('AsyncLRU set and peek', () => {
  test('set stores a value peek reads without loading', async () => {
    const lru = createAsyncLRU<string, number>({
      maxEntries: 2,
      ttlMs: 60_000,
    });
    expect(lru.peek('a')).toBeUndefined();
    lru.set('a', 1);
    expect(lru.peek('a')).toBe(1);
    expect(await lru.getOrCreate('a', () => Promise.resolve(2))).toBe(1);
    // A pending load isn't readable yet.
    void lru.getOrCreate('b', () => new Promise(() => {}));
    expect(lru.peek('b')).toBeUndefined();
  });
});

describe('GET /api/github-org-repo-search', () => {
  const search = (query: string, token: string) =>
    GET(
      new NextRequest(
        `https://diffshub.test/api/github-org-repo-search?q=${encodeURIComponent(query)}`,
        { headers: { authorization: `Bearer ${token}` } }
      )
    );

  test('ranks org repos fuzzily and returns only readable ones', async () => {
    stubGitHub({
      orgPages: {
        'search-org': [
          [
            repo('lattice-sdk', 'internal'),
            repo('lattice-secret', 'private'),
            repo('unrelated', 'internal'),
          ],
        ],
      },
      orgs: ['search-org'],
      readable: new Set(['search-org/lattice-sdk']),
    });
    await refreshOrgListing('search-org', 'token-search');
    const response = await search('lattice', 'token-search');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      pending: false,
      repos: ['search-org/lattice-sdk'],
    });
  });

  test('an owner part narrows the orgs before matching names', async () => {
    stubGitHub({
      orgPages: {
        'owner-a': [[repo('tools', 'public')]],
        'owner-b': [[repo('tools', 'public')]],
      },
      orgs: ['owner-a', 'owner-b'],
      readable: new Set(['owner-a/tools', 'owner-b/tools']),
    });
    await refreshOrgListing('owner-a', 'token-owner');
    await refreshOrgListing('owner-b', 'token-owner');
    const response = await search('owner-b/tls', 'token-owner');
    expect(((await response.json()) as { repos: string[] }).repos).toEqual([
      'owner-b/tools',
    ]);
  });

  test('a repo made private after listing is hidden from viewers without access', async () => {
    stubGitHub({
      orgPages: { 'flip-org': [[repo('was-public', 'public')]] },
      orgs: ['flip-org'],
    });
    await refreshOrgListing('flip-org', 'token-flip-builder');
    const response = await search('was-public', 'token-flip-viewer');
    expect(((await response.json()) as { repos: string[] }).repos).toEqual([]);
  });

  test('a pending search is not cached, so the switcher can retry', async () => {
    stubGitHub({ orgs: ['unlisted-org'] });
    const response = await search('anything', 'token-pending');
    expect(await response.json()).toEqual({ pending: true, repos: [] });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  test('an owner part reaches orgs past the searched-org cap', async () => {
    const orgs = Array.from({ length: 40 }, (_, i) => `many-${i}`);
    stubGitHub({
      orgPages: { 'many-39': [[repo('target', 'internal')]] },
      orgs,
      readable: new Set(['many-39/target']),
    });
    await refreshOrgListing('many-39', 'token-many');
    const response = await search('many-39/target', 'token-many');
    expect(((await response.json()) as { repos: string[] }).repos).toEqual([
      'many-39/target',
    ]);
  });

  test('searches orgs past the first page of memberships', async () => {
    const requests: string[] = [];
    stubGitHub({
      orgPages: { 'page-two-org': [[repo('far-away', 'internal')]] },
      readable: new Set(['page-two-org/far-away']),
    });
    const fetchOk = globalThis.fetch;
    globalThis.fetch = ((input: unknown, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/user/orgs')) {
        requests.push(url.search);
        const page = url.searchParams.get('page');
        const logins =
          page === '1'
            ? Array.from({ length: 100 }, (_, i) => `filler-${i}`)
            : ['page-two-org'];
        return Promise.resolve(json(logins.map((login) => ({ login }))));
      }
      return fetchOk(input as string, init);
    }) as typeof fetch;
    await refreshOrgListing('page-two-org', 'token-page-two');
    const response = await search('page-two-org/far', 'token-page-two');
    expect(((await response.json()) as { repos: string[] }).repos).toEqual([
      'page-two-org/far-away',
    ]);
    expect(requests).toHaveLength(2);
  });

  test('requires a token and a short query', async () => {
    const tokenless = await GET(
      new NextRequest('https://diffshub.test/api/github-org-repo-search?q=x')
    );
    expect(tokenless.status).toBe(401);
    expect((await search('x'.repeat(101), 'token-long')).status).toBe(400);
  });
});
