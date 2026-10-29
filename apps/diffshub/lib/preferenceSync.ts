import {
  fetchUserPreferences,
  updateUserPreferences,
} from './preferencesClient';
import { APIRequestError } from './pullCommentsClient';

// Mirrors the viewer's display preferences between this browser's
// localStorage and /api/preferences, so a fresh browser (or an incognito
// window) restores them after sign-in.
//
// localStorage stays the source every feature reads, which keeps the pre-paint
// theme script and signed-out use working unchanged. Features store synced
// values through readSyncedItem/writeSyncedItem, so this module owns their
// storage keys, and it copies whole values (as strings) to and from the
// server:
//
//   - Once per signed-in page load (startPreferenceSync), the server map is
//     fetched. A value the server holds replaces the local one; a value only
//     this browser holds is uploaded, which migrates browsers that predate the
//     sync. Then onPreferencesRestored callbacks for the keys that changed
//     run, so mounted consumers re-read them.
//   - After that, each writeSyncedItem queues its key, and changed values are
//     uploaded in one debounced PUT (Workers KV allows about one write per
//     second per key, and the whole map is one key).
//
// Changes made before the server map arrives (while it loads, after a failed
// load, or while signed out) win over the server's values once it does, and
// are uploaded then. This relies on features writing synced values only for
// the viewer's own changes, never to save defaults on load.
//
// Absent localStorage entries sync as '' rather than a deletion, so clearing a
// value in one browser clears it everywhere instead of being re-uploaded by
// another browser that still has it.

const SYNCED_PREFERENCES = {
  collapsePatterns: 'diffshub.collapse-patterns',
  colorMode: 'theme',
  darkTheme: 'diffshub-dark-theme',
  displaySettings: 'diffshub.display-settings',
  lightTheme: 'diffshub-light-theme',
  pinnedRepos: 'diffshub.pinned-repos',
} as const;

export type SyncedPreference = keyof typeof SYNCED_PREFERENCES;

const SYNCED_KEYS = Object.keys(SYNCED_PREFERENCES) as SyncedPreference[];

// Dispatched on window after server values were written to localStorage.
// `detail` lists the SyncedPreference keys whose local value changed; listen
// through onPreferencesRestored.
export const PREFERENCES_RESTORED_EVENT = 'diffshub:preferences-restored';

const FLUSH_DELAY_MS = 1000;
const RETRY_DELAY_MS = 15_000;

type SyncStatus = 'idle' | 'loading' | 'ready' | 'disabled';

let status: SyncStatus = 'idle';
let token = '';
// Bumped whenever the token changes so a stale load's result is ignored.
let generation = 0;
// The last value the server is known to hold, per key.
const serverValues = new Map<SyncedPreference, string>();
// Keys changed locally since they were last uploaded.
const dirtyKeys = new Set<SyncedPreference>();
let flushTimer: ReturnType<typeof setTimeout> | undefined;
let flushInFlight = false;

// A synced key's stored value, or null when nothing is stored or storage is
// unavailable (private mode, denied access).
export function readSyncedItem(key: SyncedPreference): string | null {
  try {
    return window.localStorage.getItem(SYNCED_PREFERENCES[key]);
  } catch {
    return null;
  }
}

// Stores a synced key's value (null removes it) and queues its upload. When
// storage is unavailable the value holds only in the caller's own state for
// this session, and nothing is uploaded.
export function writeSyncedItem(
  key: SyncedPreference,
  value: string | null
): void {
  if (storeLocal(key, value ?? '')) {
    queueUpload(key);
  }
}

// Runs `callback` whenever server values restored after sign-in replaced any
// of `keys` in localStorage. Returns the unsubscribe function.
export function onPreferencesRestored(
  keys: readonly SyncedPreference[],
  callback: () => void
): () => void {
  const listener = (event: Event) => {
    const restored = (event as CustomEvent<SyncedPreference[]>).detail;
    if (restored.some((key) => keys.includes(key))) {
      callback();
    }
  };
  window.addEventListener(PREFERENCES_RESTORED_EVENT, listener);
  return () => {
    window.removeEventListener(PREFERENCES_RESTORED_EVENT, listener);
  };
}

function readLocal(key: SyncedPreference): string {
  return readSyncedItem(key) ?? '';
}

// '' removes the entry. Returns whether storage accepted the write.
function storeLocal(key: SyncedPreference, value: string): boolean {
  try {
    if (value === '') {
      window.localStorage.removeItem(SYNCED_PREFERENCES[key]);
    } else {
      window.localStorage.setItem(SYNCED_PREFERENCES[key], value);
    }
    return true;
  } catch {
    return false;
  }
}

// Starts syncing for the signed-in viewer behind `nextToken`, or stops when it
// is ''. Safe to call repeatedly: a load that is running or done for the same
// token is not repeated, while a failed one is retried. A new token for the
// same viewer (a refresh) only updates the credential used for uploads.
export function startPreferenceSync(nextToken: string): void {
  if (nextToken === '') {
    token = '';
    generation++;
    status = 'idle';
    serverValues.clear();
    dirtyKeys.clear();
    clearTimeout(flushTimer);
    return;
  }
  const tokenChanged = nextToken !== token;
  token = nextToken;
  if (status === 'ready' || (!tokenChanged && status !== 'idle')) {
    return;
  }
  void loadServerPreferences(++generation);
}

async function loadServerPreferences(loadGeneration: number): Promise<void> {
  status = 'loading';
  let snapshot;
  try {
    snapshot = await fetchUserPreferences(token);
  } catch {
    if (loadGeneration === generation) {
      status = 'idle';
    }
    return;
  }
  if (loadGeneration !== generation) {
    return;
  }
  if (!snapshot.enabled) {
    status = 'disabled';
    dirtyKeys.clear();
    return;
  }
  const restored: SyncedPreference[] = [];
  serverValues.clear();
  for (const key of SYNCED_KEYS) {
    const remote = snapshot.preferences[key];
    if (typeof remote !== 'string') {
      if (readLocal(key) !== '') {
        dirtyKeys.add(key);
      }
      continue;
    }
    serverValues.set(key, remote);
    if (
      !dirtyKeys.has(key) &&
      readLocal(key) !== remote &&
      storeLocal(key, remote)
    ) {
      restored.push(key);
    }
  }
  status = 'ready';
  if (restored.length > 0) {
    window.dispatchEvent(
      new CustomEvent(PREFERENCES_RESTORED_EVENT, { detail: restored })
    );
  }
  if (dirtyKeys.size > 0) {
    void flushPreferences();
  }
}

// Marks a locally written key for upload: debounced once the server map has
// loaded, or with the load's own upload before then.
function queueUpload(key: SyncedPreference): void {
  if (status === 'disabled') {
    return;
  }
  dirtyKeys.add(key);
  if (status === 'ready') {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}

function scheduleFlush(delay: number): void {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = undefined;
    void flushPreferences();
  }, delay);
}

// Uploads every dirty key whose local value differs from the server's. One
// PUT runs at a time; keys changed meanwhile wait for the next one.
async function flushPreferences({ keepalive = false } = {}): Promise<void> {
  if (status !== 'ready' || flushInFlight) {
    return;
  }
  const changes: Record<string, string> = {};
  for (const key of dirtyKeys) {
    const value = readLocal(key);
    if (serverValues.get(key) !== value) {
      changes[key] = value;
    }
  }
  dirtyKeys.clear();
  const sentKeys = Object.keys(changes) as SyncedPreference[];
  if (sentKeys.length === 0) {
    return;
  }
  const flushGeneration = generation;
  flushInFlight = true;
  try {
    await updateUserPreferences(token, changes, { keepalive });
    if (flushGeneration === generation) {
      for (const key of sentKeys) {
        serverValues.set(key, changes[key]);
      }
    }
  } catch (error) {
    if (flushGeneration !== generation) {
      return;
    }
    if (error instanceof APIRequestError && error.status === 404) {
      status = 'disabled';
    } else if (
      error instanceof APIRequestError &&
      error.status >= 400 &&
      error.status < 500
    ) {
      // Rejected (e.g. a value over the size cap); resending cannot succeed.
    } else {
      for (const key of sentKeys) {
        dirtyKeys.add(key);
      }
      scheduleFlush(RETRY_DELAY_MS);
    }
  } finally {
    flushInFlight = false;
  }
  if (dirtyKeys.size > 0 && flushTimer == null) {
    scheduleFlush(FLUSH_DELAY_MS);
  }
}

// Sends a pending debounced upload right away, as a keepalive request so it
// survives the page closing. Called when the page is hidden.
export function flushPendingPreferences(): void {
  if (flushTimer == null) {
    return;
  }
  clearTimeout(flushTimer);
  flushTimer = undefined;
  void flushPreferences({ keepalive: true });
}

// Restores module state between tests.
export function resetPreferenceSyncForTests(): void {
  startPreferenceSync('');
  flushInFlight = false;
}
