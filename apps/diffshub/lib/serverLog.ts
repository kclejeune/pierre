// Structured server-side logging, as one JSON object per line so container log
// collectors can stream and filter it (`docker logs`, `kubectl logs`,
// Cloudwatch, Workers tail). Holds the shared emit primitive plus the
// failed-upstream-GitHub-request record; successful proxying stays silent.
//
// Diagnosing a refused GitHub request usually comes down to three things the
// browser never sees: the status, GitHub's own request id (quotable in a GHES
// support ticket), and the scope headers that say what the endpoint wanted
// versus what the presented credential carried. All three are recorded here.

// The one place a log line is serialized and given a stream: `level: 'error'`
// goes to stderr so failures can be filtered from access logs, everything else
// to stdout. `time` is stamped here so no caller has to remember it.
export function emitLogLine(record: Record<string, unknown>): void {
  const line = JSON.stringify({ time: new Date().toISOString(), ...record });
  if (record.level === 'error') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export function formatError(error: unknown): string {
  return error instanceof Error
    ? error.message
    : typeof error === 'string'
      ? error
      : 'Unknown error';
}

// Query values are dropped by default: an avatar lookup carries a user's email
// address and a redirected asset URL carries a signed download token. Only
// values that are safe and useful to see are kept.
const LOGGED_QUERY_PARAMS = new Set(['s', 'size', 'v']);

const REDACTED = '[redacted]';

// The upstream URL with sensitive query values removed. Invalid values are
// replaced because they cannot be inspected safely for credentials.
export function sanitizeUpstreamURL(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return '[invalid URL]';
  }
  for (const key of [...url.searchParams.keys()]) {
    if (!LOGGED_QUERY_PARAMS.has(key)) {
      url.searchParams.set(key, REDACTED);
    }
  }
  return url.toString();
}

// Headers worth recording on a failure, none of them secret. The scope pair is
// what distinguishes "this credential lacks a scope" from "this endpoint is not
// available to this credential type at all": GitHub omits
// x-accepted-github-permissions for endpoints its App tokens cannot reach.
const LOGGED_RESPONSE_HEADERS = [
  'x-github-request-id',
  'x-oauth-scopes',
  'x-accepted-oauth-scopes',
  'x-accepted-github-permissions',
  'x-ratelimit-remaining',
  'x-github-enterprise-version',
] as const;

// Which credential paid for a request, never the credential itself.
export type UpstreamCredential = 'viewer' | 'deployment-avatar' | 'none';

export interface UpstreamFailure {
  // Omitted when the shared response helper does not know whether the request
  // was authenticated.
  credential?: UpstreamCredential;
  // The thrown error, for a request that never got a response.
  error?: unknown;
  // Upstream response, for a request that completed with a failing status.
  response?: Response;
  // The API route that made the request, e.g. 'github-web-asset'.
  route: string;
  upstreamURL: string;
}

export function logUpstreamFailure({
  credential,
  error,
  response,
  route,
  upstreamURL,
}: UpstreamFailure): void {
  const record: Record<string, unknown> = {
    event: 'github_upstream_failure',
    level: 'error',
    route,
    upstreamURL: sanitizeUpstreamURL(upstreamURL),
  };
  if (credential != null) {
    record.credential = credential;
  }
  if (response != null) {
    record.status = response.status;
    record.contentType = response.headers.get('content-type') ?? null;
    for (const header of LOGGED_RESPONSE_HEADERS) {
      const value = response.headers.get(header);
      if (value != null) {
        record[header] = value;
      }
    }
  }
  if (error != null) {
    record.error = formatError(error);
  }
  emitLogLine(record);
}
