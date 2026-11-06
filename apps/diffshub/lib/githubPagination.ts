import { fetchGitHubJSON, sendGitHubGraphQL } from './githubCommitServer';
import { githubFetch } from './githubFetch';
import type { PlainFetch } from './plainFetch';
import { asRecord } from './untypedJson';

// GitHub REST list pagination: the last page number from a response's Link
// header, so callers can fetch the remaining pages in parallel after page 1.
// A missing rel="last" means the response was the only (or final) page.
export function parseLastPage(linkHeader: string | null): number {
  const match = linkHeader?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match != null ? Number(match[1]) : 1;
}

// Fetches page 1, then pages 2..lastPageOf(first) (capped at `maxPages`) in
// parallel, returning every page in order. Callers reduce each page as it
// arrives and decide how a failed page ends the walk; one whose first page
// failed should report a last page of 1.
export async function fetchPagesInParallel<T>(
  fetchPage: (page: number) => Promise<T>,
  lastPageOf: (first: T) => number,
  maxPages: number
): Promise<T[]> {
  const first = await fetchPage(1);
  const lastPage = Math.min(lastPageOf(first), maxPages);
  const rest = await Promise.all(
    Array.from({ length: Math.max(0, lastPage - 1) }, (_, index) =>
      fetchPage(index + 2)
    )
  );
  return [first, ...rest];
}

// Exhausts a paginated GitHub listing at 100 items per page, concatenating
// what `extractItems` pulls off each page. A short page ends the walk; a
// page `extractItems` cannot read (null) ends it too, keeping whatever
// earlier pages yielded.
export async function fetchAllGitHubPages(
  pathForPage: (page: number) => string,
  extractItems: (payload: unknown) => unknown[] | null,
  token: string | undefined,
  fetcher: PlainFetch
): Promise<unknown[]> {
  const items: unknown[] = [];
  for (let page = 1; ; page += 1) {
    const payload = await fetchGitHubJSON(pathForPage(page), token, fetcher);
    const pageItems = extractItems(payload);
    if (pageItems == null) {
      break;
    }
    items.push(...pageItems);
    if (pageItems.length < 100) {
      break;
    }
  }
  return items;
}

// The cursor of a connection's next page in `direction` (its pageInfo), or
// null when it was the last.
export function readPageCursor(
  connection: unknown,
  direction: 'backward' | 'forward'
): string | null {
  const pageInfo = asRecord(asRecord(connection)?.pageInfo);
  const [hasMore, cursor] =
    direction === 'forward'
      ? [pageInfo?.hasNextPage, pageInfo?.endCursor]
      : [pageInfo?.hasPreviousPage, pageInfo?.startCursor];
  return hasMore === true && typeof cursor === 'string' ? cursor : null;
}

interface GraphQLConnectionWalk {
  query: string;
  // The query's variables other than the cursor.
  variables: Record<string, unknown>;
  token: string;
  // 'forward' passes the cursor as `$after` and follows endCursor;
  // 'backward' passes `$before` and follows startCursor.
  direction: 'backward' | 'forward';
  // Picks the connection out of a response's `data`.
  readConnection(data: unknown): unknown;
  // Receives each page's connection; return false to stop walking.
  onPage(connection: unknown): boolean | void;
  // Cursor to start from, when an earlier read already covered page one.
  cursor?: string | null;
  maxPages: number;
  // Stops between pages and cancels the in-flight request once aborted.
  signal?: AbortSignal;
}

// Walks a GraphQL connection page by page (GraphQL cursors chain, so pages
// can't fan out like REST's numbered ones). Returns whether it reached the
// connection's end, as opposed to stopping at maxPages, onPage, or the
// signal. Request errors propagate; callers that can use a partial result
// collect it in onPage and catch.
export async function walkGraphQLConnection({
  cursor = null,
  direction,
  maxPages,
  onPage,
  query,
  readConnection,
  signal,
  token,
  variables,
}: GraphQLConnectionWalk): Promise<{ exhausted: boolean }> {
  const fetcher: PlainFetch | undefined =
    signal == null
      ? undefined
      : (input, init) => githubFetch(input, { ...init, signal });
  const cursorName = direction === 'forward' ? 'after' : 'before';
  let next = cursor;
  for (let page = 0; page < maxPages; page++) {
    if (signal?.aborted === true) {
      return { exhausted: false };
    }
    const connection = readConnection(
      await sendGitHubGraphQL(
        query,
        { ...variables, [cursorName]: next },
        token,
        fetcher
      )
    );
    const keepGoing = onPage(connection) !== false;
    next = readPageCursor(connection, direction);
    if (next == null) {
      return { exhausted: true };
    }
    if (!keepGoing) {
      return { exhausted: false };
    }
  }
  return { exhausted: false };
}
