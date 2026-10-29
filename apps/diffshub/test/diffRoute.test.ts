import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { GET } from '../app/api/diff/route';
import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';

const originalFetch = globalThis.fetch;
const patchText =
  'diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n';

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createCompareRequest(): NextRequest {
  const params = new URLSearchParams({
    path: '/nikelborm/qcode-effect-v4/compare/main%40%7B1022minutes%7D...main',
  });
  return new NextRequest(`https://diffshub.com/api/diff?${params}`);
}

describe('diff route', () => {
  test.each([
    { name: 'empty stream', body: '', contentLength: undefined },
    { name: 'Content-Length: 0', body: '', contentLength: '0' },
    { name: 'bodyless response', body: null, contentLength: undefined },
    { name: 'whitespace-only stream', body: ' \n\t', contentLength: undefined },
  ])('accepts a successful $name', async ({ body, contentLength }) => {
    const headers = new Headers({ 'Content-Type': 'text/plain' });
    if (contentLength != null) {
      headers.set('Content-Length', contentLength);
    }
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(body, { headers })
    );

    const response = await GET(createCompareRequest());

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body ?? '');
  });

  test('forwards diff chunks before the upstream stream finishes', async () => {
    let upstreamController!: ReadableStreamDefaultController<Uint8Array>;
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        upstreamController = controller;
        controller.enqueue(encoder.encode(patchText));
      },
    });
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstream, { headers: { 'Content-Type': 'text/plain' } })
    );

    const response = await GET(createCompareRequest());
    const reader = response.body!.getReader();
    expect(response.status).toBe(200);
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      patchText
    );

    upstreamController.close();
    expect((await reader.read()).done).toBe(true);
    reader.releaseLock();
  });

  test('preserves real stream failures', async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('Upstream connection failed.'));
      },
    });
    spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(upstream, { headers: { 'Content-Type': 'text/plain' } })
    );

    const response = await GET(createCompareRequest());
    expect(response.text()).rejects.toThrow('Upstream connection failed.');
  });

  test.each([200, 500])(
    'rejects upstream HTML with status %i',
    async (status) => {
      spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response('<!DOCTYPE html><html>Server error</html>', {
          status,
          headers: { 'Content-Type': 'text/html' },
        })
      );

      const response = await GET(createCompareRequest());

      expect(response.status).toBe(status === 200 ? 415 : status);
      expect(response.headers.get('Content-Type')).toBe(
        'text/plain; charset=utf-8'
      );
      expect(await response.text()).not.toContain('<html>');
    }
  );

  test('sends a bare compare to the API against HEAD, the default branch', async () => {
    const savedGitHubURL = process.env.DIFFSHUB_GITHUB_URL;
    delete process.env.DIFFSHUB_GITHUB_URL;
    resetGitHubEnvironmentCache();
    try {
      const requestedURLs: string[] = [];
      spyOn(globalThis, 'fetch').mockImplementation(((
        input: RequestInfo | URL
      ) => {
        const url = input instanceof Request ? input.url : String(input);
        requestedURLs.push(url);
        // The anonymous web .diff URL misses, as it does for a private repo.
        return Promise.resolve(
          url.startsWith('https://api.github.com/')
            ? new Response(patchText, {
                headers: { 'Content-Type': 'application/vnd.github.diff' },
              })
            : new Response('Not Found', { status: 404 })
        );
      }) as typeof fetch);

      const params = new URLSearchParams({
        path: '/acme/widgets/compare/klejeune/topic',
      });
      const response = await GET(
        new NextRequest(`https://diffshub.com/api/diff?${params}`, {
          headers: { Authorization: 'Bearer test-token' },
        })
      );

      expect(response.status).toBe(200);
      expect(await response.text()).toBe(patchText);
      expect(requestedURLs).toContain(
        'https://api.github.com/repos/acme/widgets/compare/HEAD...klejeune%2Ftopic'
      );
    } finally {
      if (savedGitHubURL == null) {
        delete process.env.DIFFSHUB_GITHUB_URL;
      } else {
        process.env.DIFFSHUB_GITHUB_URL = savedGitHubURL;
      }
      resetGitHubEnvironmentCache();
    }
  });
});
