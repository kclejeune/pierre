import { type NextRequest } from 'next/server';

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

// Wraps a route handler so every request is logged with its method, path,
// status, and duration. A thrown error is logged with its stack and rethrown so
// Next's own error handling still applies.
export function withRequestLog(handler: RouteHandler): LoggedRouteHandler {
  return async (request: NextRequest) => {
    const startedAt = Date.now();
    const common = {
      event: 'api_request',
      method: request.method,
      path: request.nextUrl.pathname,
    };
    try {
      const response = await handler(request);
      emitLogLine({
        ...common,
        durationMs: Date.now() - startedAt,
        level: levelForStatus(response.status),
        status: response.status,
      });
      return response;
    } catch (error) {
      emitLogLine({
        ...common,
        durationMs: Date.now() - startedAt,
        error: formatError(error),
        level: 'error',
        stack: error instanceof Error ? error.stack : undefined,
        status: 500,
      });
      throw error;
    }
  };
}
