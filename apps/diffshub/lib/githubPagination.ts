// GitHub REST list pagination: the last page number from a response's Link
// header, so callers can fetch the remaining pages in parallel after page 1.
// A missing rel="last" means the response was the only (or final) page.
export function parseLastPage(linkHeader: string | null): number {
  const match = linkHeader?.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  return match != null ? Number(match[1]) : 1;
}
