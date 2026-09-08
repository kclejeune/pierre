import { describe, expect, test } from 'bun:test';
import { type NextRequest } from 'next/server';

import { withRequestLog } from '../lib/requestLog';
import { captureConsole, captureLogRecords } from './helpers/captureConsole';

// Only the surface withRequestLog reads.
function createRequest(method: string, pathname: string): NextRequest {
  return { method, nextUrl: { pathname } } as NextRequest;
}

describe('withRequestLog', () => {
  test('logs method, path, status, and duration for every request', async () => {
    const handler = withRequestLog(() => new Response('', { status: 200 }));
    const [record] = await captureLogRecords(() =>
      handler(createRequest('GET', '/api/github-web-asset'))
    );

    expect(record).toMatchObject({
      event: 'api_request',
      level: 'info',
      method: 'GET',
      path: '/api/github-web-asset',
      status: 200,
    });
    expect(typeof record?.durationMs).toBe('number');
  });

  // A 4xx is the caller's problem and a 5xx is ours, so they land on different
  // levels and different streams.
  test('levels a client error as warn and a server error as error', async () => {
    const [clientError] = await captureConsole(() =>
      withRequestLog(() => new Response('', { status: 401 }))(
        createRequest('GET', '/api/github-user')
      )
    );
    expect(clientError?.stream).toBe('stdout');
    expect(JSON.parse(clientError?.line ?? '')).toMatchObject({
      level: 'warn',
      status: 401,
    });

    const [serverError] = await captureConsole(() =>
      withRequestLog(() => new Response('', { status: 502 }))(
        createRequest('GET', '/api/github-user')
      )
    );
    expect(serverError?.stream).toBe('stderr');
    expect(JSON.parse(serverError?.line ?? '')).toMatchObject({
      level: 'error',
      status: 502,
    });
  });

  test('logs the message and stack of a thrown error, then rethrows', async () => {
    const handler = withRequestLog(() => {
      throw new Error('upstream exploded');
    });

    let failure: unknown;
    const [record] = await captureLogRecords(async () => {
      failure = await handler(
        createRequest('POST', '/api/pull-comments')
      ).catch((error: unknown) => error);
    });
    expect(record).toMatchObject({
      error: 'upstream exploded',
      level: 'error',
      method: 'POST',
      status: 500,
    });
    expect(String(record?.stack)).toContain('Error: upstream exploded');
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe('upstream exploded');
  });
});
