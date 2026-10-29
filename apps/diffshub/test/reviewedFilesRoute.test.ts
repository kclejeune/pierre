import { describe, expect, test } from 'bun:test';
import { NextRequest } from 'next/server';
import { createHash } from 'node:crypto';

import { GET, PUT } from '../app/api/preferences/reviewed/route';
import { setPreferenceStoreOverride } from '../lib/preferenceStore';
import {
  createMemoryStore,
  mockGitHubUser,
  nextToken,
  useCleanPreferenceRouteEnvironment,
} from './helpers/preferenceRouteKit';

const SOURCE = 'github.com/acme/widgets/pull/42';
const SOURCE_DIGEST = createHash('sha256').update(SOURCE).digest('hex');
const FINGERPRINT = `oid:${'a'.repeat(40)}`;

useCleanPreferenceRouteEnvironment();

function getRequest(token: string, source: string | null): NextRequest {
  const url = new URL('https://diffshub.com/api/preferences/reviewed');
  if (source != null) {
    url.searchParams.set('source', source);
  }
  return new NextRequest(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
}

function putRequest(token: string, body: unknown): NextRequest {
  return new NextRequest('https://diffshub.com/api/preferences/reviewed', {
    body: JSON.stringify(body),
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    method: 'PUT',
  });
}

async function readFiles(token: string, source = SOURCE): Promise<unknown> {
  return (
    (await (await GET(getRequest(token, source))).json()) as {
      files: unknown;
    }
  ).files;
}

describe('/api/preferences/reviewed', () => {
  test('reports itself disabled when no store is configured', async () => {
    setPreferenceStoreOverride(undefined);
    const read = await GET(getRequest(nextToken(), SOURCE));
    expect(await read.json()).toEqual({ enabled: false, files: null });
    const write = await PUT(
      putRequest(nextToken(), { files: {}, source: SOURCE })
    );
    expect(write.status).toBe(404);
  });

  test('stores marks per user and source with a TTL, never the token', async () => {
    const store = createMemoryStore();
    setPreferenceStoreOverride(store);
    mockGitHubUser(583231);
    const token = nextToken();

    expect(await readFiles(token)).toBeNull();

    const write = await PUT(
      putRequest(token, { files: { 'src/a.ts': FINGERPRINT }, source: SOURCE })
    );
    expect(await write.json()).toEqual({ enabled: true });
    const key = `diffshub:reviewed:v1:https://github.com:583231:${SOURCE_DIGEST}`;
    expect([...store.data.keys()]).toEqual([key]);
    expect(store.ttls.get(key)).toBe(90 * 24 * 60 * 60);
    expect([...store.data.values()].join('')).not.toContain(token);

    // Another token for the same user reads the same marks.
    expect(await readFiles(nextToken())).toEqual({ 'src/a.ts': FINGERPRINT });
    // A different source stays separate.
    expect(await readFiles(token, `${SOURCE}/other`)).toBeNull();
  });

  test('keeps an empty map as a stored record', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    mockGitHubUser(3);
    const token = nextToken();
    await PUT(putRequest(token, { files: {}, source: SOURCE }));
    expect(await readFiles(token)).toEqual({});
  });

  test('drops malformed and credential-shaped entries instead of failing', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    mockGitHubUser(9);
    const token = nextToken();
    const response = await PUT(
      putRequest(token, {
        files: {
          [`leak/ghp_${'a'.repeat(36)}.txt`]: FINGERPRINT,
          [`own/${token}.txt`]: FINGERPRINT,
          'bad-fingerprint.ts': 'not a fingerprint',
          'kept.ts': 'h:1a2b3c',
          'number.ts': 5,
        },
        source: SOURCE,
      })
    );
    expect(response.status).toBe(200);
    expect(await readFiles(token)).toEqual({ 'kept.ts': 'h:1a2b3c' });
  });

  test('rejects a missing or oversized source', async () => {
    setPreferenceStoreOverride(createMemoryStore());
    mockGitHubUser(4);
    const token = nextToken();
    expect((await GET(getRequest(token, null))).status).toBe(400);
    expect(
      (await PUT(putRequest(token, { files: {}, source: 'x'.repeat(2049) })))
        .status
    ).toBe(400);
    expect(
      (await PUT(putRequest(token, { files: [], source: SOURCE }))).status
    ).toBe(400);
  });
});
