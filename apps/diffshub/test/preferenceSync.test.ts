import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { createFakeWindow } from './helpers/fakeWindow';
import { recordFetch, settle } from './helpers/recordFetch';
import {
  flushPendingPreferences,
  PREFERENCES_RESTORED_EVENT,
  resetPreferenceSyncForTests,
  startPreferenceSync,
  writeSyncedItem,
} from '@/lib/preferenceSync';

let fake: ReturnType<typeof createFakeWindow>;
const originalWindow = globalThis.window;
const originalFetch = globalThis.fetch;

// Serves /api/preferences from an in-memory map and records each request.
function mockPreferencesAPI(
  server: Record<string, unknown>,
  { enabled = true } = {}
) {
  return recordFetch(({ body, method }) => {
    if (!enabled) {
      return method === 'GET'
        ? Response.json({ enabled: false, preferences: {} })
        : Response.json({ error: 'disabled' }, { status: 404 });
    }
    if (method === 'PUT') {
      Object.assign(
        server,
        (body as { preferences: Record<string, unknown> }).preferences
      );
    }
    return Response.json({ enabled: true, preferences: server });
  });
}

function restoredEvents(): string[][] {
  return fake.events
    .filter((event) => event.type === PREFERENCES_RESTORED_EVENT)
    .map((event) => (event as CustomEvent<string[]>).detail);
}

beforeEach(() => {
  fake = createFakeWindow();
  globalThis.window = fake.window;
  resetPreferenceSyncForTests();
});

afterEach(() => {
  resetPreferenceSyncForTests();
  globalThis.window = originalWindow;
  globalThis.fetch = originalFetch;
});

describe('preference sync', () => {
  test('restores server values over local ones and announces them', async () => {
    fake.store.set('theme', 'light');
    fake.store.set('diffshub-dark-theme', 'one-dark-pro');
    mockPreferencesAPI({ colorMode: 'dark', darkTheme: 'one-dark-pro' });

    startPreferenceSync('token-a');
    await settle();

    expect(fake.store.get('theme')).toBe('dark');
    expect(restoredEvents()).toEqual([['colorMode']]);
  });

  test('uploads values only this browser has', async () => {
    fake.store.set('diffshub.pinned-repos', '["acme/widgets"]');
    const requests = mockPreferencesAPI({});

    startPreferenceSync('token-a');
    await settle();

    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1].body).toEqual({
      preferences: { pinnedRepos: '["acme/widgets"]' },
    });
  });

  test('a change made while the server map loads wins over it', async () => {
    const requests = mockPreferencesAPI({
      displaySettings: '{"overflow":"wrap"}',
    });

    startPreferenceSync('token-a');
    writeSyncedItem('displaySettings', '{"overflow":"scroll"}');
    await settle();

    expect(fake.store.get('diffshub.display-settings')).toBe(
      '{"overflow":"scroll"}'
    );
    expect(restoredEvents()).toEqual([]);
    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1].body).toEqual({
      preferences: { displaySettings: '{"overflow":"scroll"}' },
    });
  });

  test('changes made after a failed load win once a retry succeeds', async () => {
    fake.store.set('theme', 'light');
    const server: Record<string, unknown> = { colorMode: 'light' };
    let failing = true;
    const requests = recordFetch(({ body, method }) => {
      if (failing) {
        return Response.json({ error: 'down' }, { status: 503 });
      }
      if (method === 'PUT') {
        Object.assign(
          server,
          (body as { preferences: Record<string, unknown> }).preferences
        );
      }
      return Response.json({ enabled: true, preferences: server });
    });

    startPreferenceSync('token-a');
    await settle();
    writeSyncedItem('colorMode', 'dark');

    failing = false;
    startPreferenceSync('token-a');
    await settle();

    expect(fake.store.get('theme')).toBe('dark');
    expect(server.colorMode).toBe('dark');
    expect(requests.map((request) => request.method)).toEqual([
      'GET',
      'GET',
      'PUT',
    ]);
  });

  test('uploads later changes, and a cleared value as an empty string', async () => {
    fake.store.set('diffshub.collapse-patterns', 'vendor');
    const requests = mockPreferencesAPI({ collapsePatterns: 'vendor' });
    startPreferenceSync('token-a');
    await settle();

    writeSyncedItem('collapsePatterns', null);
    flushPendingPreferences();
    await settle();

    expect(requests.map((request) => request.method)).toEqual(['GET', 'PUT']);
    expect(requests[1].body).toEqual({
      preferences: { collapsePatterns: '' },
    });
  });

  test('sends nothing when the value matches the server', async () => {
    fake.store.set('theme', 'dark');
    const requests = mockPreferencesAPI({ colorMode: 'dark' });
    startPreferenceSync('token-a');
    await settle();

    writeSyncedItem('colorMode', 'dark');
    flushPendingPreferences();
    await settle();

    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  test('a refreshed token for the same session does not refetch', async () => {
    const requests = mockPreferencesAPI({});
    startPreferenceSync('token-a');
    await settle();
    startPreferenceSync('token-b');
    await settle();
    expect(requests.map((request) => request.method)).toEqual(['GET']);
  });

  test('stays local-only when the deployment has no store', async () => {
    fake.store.set('theme', 'dark');
    const requests = mockPreferencesAPI({}, { enabled: false });
    startPreferenceSync('token-a');
    await settle();

    writeSyncedItem('colorMode', 'light');
    flushPendingPreferences();
    await settle();

    expect(requests.map((request) => request.method)).toEqual(['GET']);
    expect(fake.store.get('theme')).toBe('light');
  });
});
