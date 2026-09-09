import { type NextRequest } from 'next/server';
import { AsyncLocalStorage } from 'node:async_hooks';

import { emitLogLine, formatError } from './serverLog';

// Access logging for the API routes: one JSON object per line, emitted through
// lib/serverLog so failures land on stderr and carry the error message and
// stack.
//
// This is a wrapper rather than Next middleware because middleware only decides
// whether a request proceeds — `NextResponse.next()` is an instruction, not an
// awaited response — so it can see neither the status a handler produced nor an
// error it threw. Wrapping the exported handler can.

type RouteHandler = (request: NextRequest) => Promise<Response> | Response;
type LoggedRouteHandler = (request: NextRequest) => Promise<Response>;

function levelForStatus(status: number): 'error' | 'info' | 'warn' {
  if (status >= 500) {
    return 'error';
  }
  return status >= 400 ? 'warn' : 'info';
}

// The route currently being served, so shared helpers can label their upstream
// failures without every caller threading a string down to them. Helpers like
// githubCommitServer and githubDiffFileServer are reached from several routes,
// so a literal baked into the helper would misattribute most of its log lines.
const currentRoute = new AsyncLocalStorage<string>();

// The route label for the request in flight, or `fallback` when the caller is
// not inside a logged route (startup work, tests, direct helper use).
export function getCurrentRouteLabel(fallback: string): string {
  return currentRoute.getStore() ?? fallback;
}

// Wraps a route handler so every request is logged with its method, path,
// status, and handler duration. Streaming bodies can outlive the handler, so
// the field is deliberately named handlerDurationMs rather than implying that
// it measures the full response transfer. A thrown error is logged with its
// stack and rethrown so Next's own error handling still applies.
export function withRequestLog(handler: RouteHandler): LoggedRouteHandler {
  return async (request: NextRequest) => {
    const startedAt = Date.now();
    const path = request.nextUrl.pathname;
    const common = {
      event: 'api_request',
      method: request.method,
      path,
    };
    try {
      const response = await currentRoute.run(
        routeLabelFromPath(path),
        async () => await handler(request)
      );
      emitLogLine({
        ...common,
        handlerDurationMs: Date.now() - startedAt,
        level: levelForStatus(response.status),
        status: response.status,
      });
      return response;
    } catch (error) {
      emitLogLine({
        ...common,
        handlerDurationMs: Date.now() - startedAt,
        error: formatError(error),
        level: 'error',
        stack: error instanceof Error ? error.stack : undefined,
        status: 500,
      });
      throw error;
    }
  };
}

// Routes label themselves with the bare segment ('pull-comments'), not the
// '/api/' path, so derived labels match the ones the route files pass by hand.
function routeLabelFromPath(path: string): string {
  return path.replace(/^\/api\//, '').replace(/\/+$/, '');
}
