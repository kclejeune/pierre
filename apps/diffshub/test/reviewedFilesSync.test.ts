import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import {
  type RecordedRequest,
  recordFetch,
  settle,
} from './helpers/recordFetch';
import {
  loadReviewedFiles,
  saveReviewedFiles,
  syncReviewedFiles,
} from '@/lib/reviewedFiles';
import {
  flushPendingReviewedFiles,
  resetReviewedFilesSyncForTests,
} from '@/lib/reviewedFilesSync';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

const SOURCE = 'github.com/acme/widgets/pull/42';
const LOCAL_KEY = `diffshub.reviewed.${SOURCE}`;
const FP_A = `oid:${'a'.repeat(40)}`;
const FP_B = `oid:${'b'.repeat(40)}`;

// Serves /api/preferences/reviewed for one source and records each request.
function mockReviewedAPI(stored: Record<string, string> | null) {
  let files = stored;
  return recordFetch(({ body, method }) => {
    if (method === 'PUT') {
      files = (body as { files: Record<string, string> }).files;
      return Response.json({ enabled: true });
    }
    return Response.json({ enabled: true, files });
  });
}

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
  resetReviewedFilesSyncForTests();
});

afterEach(() => {
  resetReviewedFilesSyncForTests();
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

describe('reviewed-file sync', () => {
  test('replaces local marks with the server copy', async () => {
    fake.store.set(LOCAL_KEY, JSON.stringify({ 'old.ts': FP_B }));
    mockReviewedAPI({ 'a.ts': FP_A });
    const restored: Map<string, string>[] = [];

    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      (files) => restored.push(files)
    );
    await settle();

    expect(restored).toEqual([new Map([['a.ts', FP_A]])]);
    expect(loadReviewedFiles(SOURCE)).toEqual(new Map([['a.ts', FP_A]]));
  });

  test('uploads local marks the server has never seen', async () => {
    fake.store.set(LOCAL_KEY, JSON.stringify({ 'a.ts': FP_A }));
    const requests = mockReviewedAPI(null);
    const onRestored = mock(() => {});

    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      onRestored
    );
    await settle();
    flushPendingReviewedFiles();
    await settle();

    expect(onRestored).not.toHaveBeenCalled();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1].body).toEqual({
      files: { 'a.ts': FP_A },
      source: SOURCE,
    });
  });

  test('uploads changes once the server copy has loaded', async () => {
    const requests = mockReviewedAPI({});
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );

    // Saved while the GET is still in flight: the server copy wins.
    saveReviewedFiles(SOURCE, new Map([['early.ts', FP_A]]));
    await settle();
    flushPendingReviewedFiles();
    await settle();
    expect(requests.map((request) => request.method)).toEqual(['GET']);

    saveReviewedFiles(SOURCE, new Map([['b.ts', FP_B]]));
    flushPendingReviewedFiles();
    await settle();
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1].body).toEqual({
      files: { 'b.ts': FP_B },
      source: SOURCE,
    });
  });

  test('stays local-only without a token', async () => {
    const requests = mockReviewedAPI({ 'a.ts': FP_A });
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => '',
      () => {}
    );
    saveReviewedFiles(SOURCE, new Map([['b.ts', FP_B]]));
    flushPendingReviewedFiles();
    await settle();
    expect(requests).toEqual([]);
  });

  test('does not re-upload marks the server already holds', async () => {
    const requests = mockReviewedAPI({ 'a.ts': FP_A });
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );
    await settle();

    saveReviewedFiles(SOURCE, new Map([['a.ts', FP_A]]));
    flushPendingReviewedFiles();
    await settle();
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });
});

// A reviewed-files API whose replies are held until the test releases them,
// in any order. The server map changes only when a PUT's reply is released,
// as if the server processed requests in that order.
function heldReviewedAPI(stored: Record<string, string> | null) {
  let files = stored;
  const held: { release(): void; request: RecordedRequest }[] = [];
  const requests = recordFetch(
    (request) =>
      new Promise<Response>((resolve) => {
        held.push({
          release() {
            if (request.method === 'PUT') {
              files = (request.body as { files: Record<string, string> }).files;
              resolve(Response.json({ enabled: true }));
            } else {
              resolve(Response.json({ enabled: true, files }));
            }
          },
          request,
        });
      })
  );
  return {
    held,
    requests,
    serverFiles: () => files,
    // Releases the oldest held reply of the given method.
    async release(method: string) {
      await settle();
      const index = held.findIndex((entry) => entry.request.method === method);
      if (index === -1) {
        throw new Error(`No held ${method} request to release.`);
      }
      held.splice(index, 1)[0].release();
      await settle();
    },
  };
}

function methods(requests: RecordedRequest[]): string[] {
  return requests.map((request) => request.method);
}

describe('reviewed-file sync ordering', () => {
  test('runs one upload per source at a time and sends the latest map last', async () => {
    const api = heldReviewedAPI({});
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );
    await api.release('GET');

    saveReviewedFiles(SOURCE, new Map([['a.ts', FP_A]]));
    flushPendingReviewedFiles();
    await settle();
    saveReviewedFiles(
      SOURCE,
      new Map([
        ['a.ts', FP_A],
        ['b.ts', FP_B],
      ])
    );
    flushPendingReviewedFiles();
    await settle();
    // The second change waits for the first PUT instead of racing it.
    expect(methods(api.requests)).toEqual(['GET', 'PUT']);

    await api.release('PUT');
    expect(methods(api.requests)).toEqual(['GET', 'PUT', 'PUT']);
    await api.release('PUT');
    expect(api.serverFiles()).toEqual({ 'a.ts': FP_A, 'b.ts': FP_B });
  });

  test('a reopened source waits for its queued upload before reading the server', async () => {
    const api = heldReviewedAPI({});
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );
    await api.release('GET');
    saveReviewedFiles(SOURCE, new Map([['a.ts', FP_A]]));

    // Reopened (e.g. a refreshed token) with the upload still debounced.
    const restored: Map<string, string>[] = [];
    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      (files) => restored.push(files)
    );
    await settle();
    expect(methods(api.requests)).toEqual(['GET', 'PUT']);

    await api.release('PUT');
    expect(methods(api.requests)).toEqual(['GET', 'PUT', 'GET']);
    await api.release('GET');
    expect(restored).toEqual([new Map([['a.ts', FP_A]])]);
    expect(loadReviewedFiles(SOURCE)).toEqual(new Map([['a.ts', FP_A]]));
  });

  test('migrates the latest local marks, not the ones from when the diff opened', async () => {
    fake.store.set(LOCAL_KEY, JSON.stringify({ 'a.ts': FP_A }));
    const api = heldReviewedAPI(null);
    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      () => {}
    );
    // Unchecked a.ts and checked b.ts while the GET was pending.
    saveReviewedFiles(SOURCE, new Map([['b.ts', FP_B]]));
    await api.release('GET');
    await api.release('PUT');

    expect(api.requests[1].body).toEqual({
      files: { 'b.ts': FP_B },
      source: SOURCE,
    });
    expect(api.serverFiles()).toEqual({ 'b.ts': FP_B });
  });

  test('sends a large map without keepalive and keeps it for the next open if it fails', async () => {
    const big = new Map(
      Array.from({ length: 1000 }, (_, index) => [
        `src/components/feature-${index}/Component${index}.tsx`,
        FP_A,
      ])
    );
    let failPuts = true;
    let serverFiles: Record<string, string> = {};
    const requests = recordFetch(({ body, method }) => {
      if (method === 'PUT') {
        if (failPuts) {
          return Response.json({ error: 'down' }, { status: 503 });
        }
        serverFiles = (body as { files: Record<string, string> }).files;
        return Response.json({ enabled: true });
      }
      return Response.json({ enabled: true, files: serverFiles });
    });
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );
    await settle();

    saveReviewedFiles(SOURCE, big);
    flushPendingReviewedFiles();
    await settle();
    expect(requests[1]).toMatchObject({ keepalive: false, method: 'PUT' });

    // Next open: the server still has the old empty map, but the local marks
    // were never confirmed, so they are uploaded rather than replaced.
    failPuts = false;
    const onRestored = mock(() => {});
    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      onRestored
    );
    await settle();
    expect(onRestored).not.toHaveBeenCalled();
    expect(Object.keys(serverFiles)).toHaveLength(1000);
  });

  test('a small map is flushed with keepalive', async () => {
    const requests = mockReviewedAPI({});
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => 'token',
      () => {}
    );
    await settle();
    saveReviewedFiles(SOURCE, new Map([['a.ts', FP_A]]));
    flushPendingReviewedFiles();
    await settle();
    expect(requests[1]).toMatchObject({ keepalive: true, method: 'PUT' });
  });

  test('marks changed while signed out are uploaded on the next signed-in open', async () => {
    const requests = mockReviewedAPI({ 'old.ts': FP_B });
    syncReviewedFiles(
      SOURCE,
      new Map(),
      () => '',
      () => {}
    );
    saveReviewedFiles(SOURCE, new Map([['a.ts', FP_A]]));

    const onRestored = mock(() => {});
    syncReviewedFiles(
      SOURCE,
      loadReviewedFiles(SOURCE),
      () => 'token',
      onRestored
    );
    await settle();
    expect(onRestored).not.toHaveBeenCalled();
    expect(requests[1].body).toEqual({
      files: { 'a.ts': FP_A },
      source: SOURCE,
    });
  });
});
