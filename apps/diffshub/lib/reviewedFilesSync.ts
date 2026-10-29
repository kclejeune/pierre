import { fetchReviewedFiles, updateReviewedFiles } from './preferencesClient';
import { APIRequestError } from './pullCommentsClient';
import type { ReviewedFilesRecord } from './reviewedFilesPayload';
import { readStoredJSON, writeStoredJSON } from './storedJSON';

// Mirrors one diff source's reviewed-file marks between localStorage
// (lib/reviewedFiles) and /api/preferences/reviewed.
//
//   - When a diff opens, marks the server holds replace the local ones, and
//     local marks the server has never seen are uploaded. Marks changed while
//     the server copy loads are kept for that upload, but otherwise the
//     server's copy wins: loading a diff also prunes stale marks locally, and
//     that cleanup must not overwrite marks set in another browser.
//   - After that, each change is uploaded in a debounced PUT of the source's
//     whole map. One PUT per source runs at a time and later changes wait for
//     it, so out-of-order replies cannot leave an older map stored.
//   - A source with changes the server has not confirmed carries an
//     "unsynced" flag in localStorage. It survives a closed tab or a failed
//     upload, and on the next open the local marks are uploaded instead of
//     being replaced by the server's older copy. Changes made with no sync
//     running (signed out, or the server unreachable) set it too.

const FLUSH_DELAY_MS = 1000;
const UNSYNCED_PREFIX = 'diffshub.reviewed-unsynced.';

interface SourceSync {
  // Set when the diff closes; the entry is dropped once no write is pending.
  closed: boolean;
  getToken(): string;
  // The upload running now, if any.
  inFlight?: Promise<void>;
  // JSON of the marks the server has confirmed, so an unchanged map is not
  // uploaded again.
  lastSent?: string;
  // This browser's current marks for the source.
  latest: ReviewedFilesRecord;
  // False until the server copy has loaded and been reconciled.
  ready: boolean;
  // Set when a change arrives during an upload; it is sent once that ends.
  sendAgain: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

// One entry per open diff source, plus closed ones with a write pending.
const sources = new Map<string, SourceSync>();
// Set once the server reports that this deployment stores no preferences.
let disabled = false;

function isUnsynced(source: string): boolean {
  return readStoredJSON(UNSYNCED_PREFIX + source) === true;
}

function setUnsynced(source: string, unsynced: boolean): void {
  writeStoredJSON(UNSYNCED_PREFIX + source, unsynced ? true : null);
}

// Reconciles `source` with the server as a diff opens. `local` is this
// browser's marks; `onRestored` receives the server's marks when they should
// replace the local ones. Returns a function to call when the diff closes or
// reloads; writes already queued still go out.
export function restoreReviewedFiles(
  source: string,
  local: ReviewedFilesRecord,
  getToken: () => string,
  onRestored: (files: ReviewedFilesRecord) => void
): () => void {
  if (disabled || getToken() === '') {
    return () => {};
  }
  const previous = sources.get(source);
  const sync: SourceSync = {
    closed: false,
    getToken,
    latest: local,
    ready: false,
    sendAgain: false,
  };
  sources.set(source, sync);
  const controller = new AbortController();
  // A reopen (a retry or a refreshed token) first lets the previous open's
  // writes land, so the server copy read next already includes them.
  const previousWrites =
    previous == null ? Promise.resolve() : finishWrites(source, previous);
  void previousWrites
    .then(() => fetchReviewedFiles(sync.getToken(), source, controller.signal))
    .then(
      (snapshot) => {
        if (sources.get(source) !== sync) {
          return;
        }
        if (!snapshot.enabled) {
          disabled = true;
          sources.delete(source);
          return;
        }
        sync.ready = true;
        const unsynced = isUnsynced(source);
        if (snapshot.files != null && !unsynced) {
          sync.lastSent = JSON.stringify(snapshot.files);
          sync.latest = snapshot.files;
          onRestored(snapshot.files);
        } else if (
          snapshot.files == null &&
          Object.keys(sync.latest).length === 0
        ) {
          if (unsynced) {
            setUnsynced(source, false);
          }
        } else {
          // Nothing stored yet, or local changes the server never confirmed:
          // upload this browser's latest marks.
          setUnsynced(source, true);
          send(source, sync);
        }
      },
      () => {
        // Unreachable, rejected, or closed first: local-only for this open.
        if (sources.get(source) === sync) {
          sources.delete(source);
        }
      }
    );
  return () => {
    controller.abort();
    sync.closed = true;
    dropIfIdle(source, sync);
  };
}

// Called after lib/reviewedFiles writes a source's marks to localStorage.
export function noteReviewedFilesChanged(
  source: string,
  files: ReviewedFilesRecord
): void {
  if (disabled) {
    return;
  }
  const sync = sources.get(source);
  if (sync == null) {
    // No sync running for this source: remember to upload on the next open.
    setUnsynced(source, true);
    return;
  }
  sync.latest = files;
  if (!sync.ready) {
    return;
  }
  setUnsynced(source, true);
  clearTimeout(sync.timer);
  sync.timer = setTimeout(() => {
    sync.timer = undefined;
    send(source, sync);
  }, FLUSH_DELAY_MS);
}

// Uploads the source's latest marks unless the server already has them. While
// an upload runs, a new request only marks that another is needed.
function send(source: string, sync: SourceSync, keepalive = false): void {
  if (sync.inFlight != null) {
    sync.sendAgain = true;
    return;
  }
  const files = sync.latest;
  const serialized = JSON.stringify(files);
  const token = sync.getToken();
  if (serialized === sync.lastSent) {
    setUnsynced(source, false);
  }
  if (serialized === sync.lastSent || token === '') {
    dropIfIdle(source, sync);
    return;
  }
  sync.inFlight = updateReviewedFiles(token, source, files, { keepalive })
    .then(
      () => {
        sync.lastSent = serialized;
        if (JSON.stringify(sync.latest) === serialized) {
          setUnsynced(source, false);
        }
      },
      (error: unknown) => {
        if (error instanceof APIRequestError && error.status === 404) {
          disabled = true;
        }
        // The unsynced flag stays set, so the next change or the next open
        // uploads these marks again.
      }
    )
    .finally(() => {
      sync.inFlight = undefined;
      if (sync.sendAgain) {
        sync.sendAgain = false;
        send(source, sync);
      } else {
        dropIfIdle(source, sync);
      }
    });
}

// Sends a queued upload now and resolves once no upload is running.
async function finishWrites(source: string, sync: SourceSync): Promise<void> {
  if (sync.timer != null) {
    clearTimeout(sync.timer);
    sync.timer = undefined;
    send(source, sync);
  }
  while (sync.inFlight != null) {
    await sync.inFlight;
  }
}

function dropIfIdle(source: string, sync: SourceSync): void {
  if (
    sync.closed &&
    sync.timer == null &&
    sync.inFlight == null &&
    sources.get(source) === sync
  ) {
    sources.delete(source);
  }
}

// Sends every queued upload right away, as keepalive requests where the body
// allows (lib/preferencesClient), so marks set just before the page closes
// are not lost. Anything that still fails stays flagged unsynced.
export function flushPendingReviewedFiles(): void {
  for (const [source, sync] of sources) {
    if (sync.timer != null) {
      clearTimeout(sync.timer);
      sync.timer = undefined;
      send(source, sync, true);
    }
  }
}

// Restores module state between tests.
export function resetReviewedFilesSyncForTests(): void {
  for (const sync of sources.values()) {
    clearTimeout(sync.timer);
  }
  sources.clear();
  disabled = false;
}
