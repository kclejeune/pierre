// Follows redirects from a GitHub asset request by hand instead of with
// `redirect: 'follow'`, because the hops need different credentials than the
// initial request:
//
//  - GHES /user-attachments/ redirects to a signed /storage/ URL whose token
//    is in the query string; that URL 404s when an Authorization header is
//    also present (observed on GHES 3.20).
//  - github.com /user-attachments/ redirects cross-origin to a signed S3
//    URL, which rejects requests carrying both query-string auth and an
//    Authorization header — and forwarding the viewer's token to a foreign
//    origin would leak it besides.
//
// Every hop is therefore re-issued with the Authorization header stripped
// while other headers (User-Agent, Accept) are kept. Hops may leave the
// configured instance: the initial URL is allow-listed by the caller and each
// Location is chosen by the instance itself, not the client, so the chain
// cannot be steered to arbitrary hosts by request input.
const MAX_ASSET_REDIRECTS = 3;

export async function fetchAssetFollowingRedirects(
  initialURL: string,
  headers: HeadersInit,
  fetchImpl: typeof fetch = fetch
): Promise<Response> {
  let target = initialURL;
  let response = await fetchImpl(target, { headers, redirect: 'manual' });

  const hopHeaders = new Headers(headers);
  hopHeaders.delete('authorization');

  for (
    let hop = 0;
    hop < MAX_ASSET_REDIRECTS &&
    response.status >= 300 &&
    response.status < 400;
    hop += 1
  ) {
    const location = response.headers.get('location');
    if (location == null) {
      break;
    }
    target = new URL(location, target).toString();
    // Release the discarded 3xx response so its connection returns to the
    // pool before the next hop.
    void response.body?.cancel();
    response = await fetchImpl(target, {
      headers: hopHeaders,
      redirect: 'manual',
    });
  }

  return response;
}
