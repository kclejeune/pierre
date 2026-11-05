import { fetchGitHubJSON } from './githubCommitServer';
import type { PlainFetch } from './plainFetch';

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
