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
