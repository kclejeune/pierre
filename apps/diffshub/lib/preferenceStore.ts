// The key/value backend behind /api/preferences, chosen per deployment:
//
//   - Redis or Valkey when DIFFSHUB_REDIS_URL is set (the docker-compose
//     path). One client is shared by every request in the process.
//   - Workers KV when the Worker has a DIFFSHUB_PREFERENCES binding (the
//     Cloudflare path; see wrangler.toml). `next dev` proxies the same binding
//     to a local Miniflare namespace.
//   - Neither: the store is undefined and the preferences API reports itself
//     disabled, leaving the browser on localStorage alone.
//
// Values are opaque strings here; lib/userPreferences owns their shape.

import { readNonEmptyString } from './githubOAuthGrant';
import { emitLogLine, formatError } from './serverLog';

// Exactly the subset of the Workers KVNamespace binding used here, so a KV
// binding is a PreferenceStore as-is and the app does not need
// @cloudflare/workers-types for one interface. `expirationTtl` (seconds)
// makes the key expire that long after this write; omitted, it never does.
export interface PreferenceStore {
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number }
  ): Promise<void>;
}

// How long a request waits for Redis before answering 503. The client keeps
// reconnecting in the background; this only bounds each request's wait.
const REDIS_COMMAND_TIMEOUT_MS = 3000;

// A connected Redis client behind the stall-and-timeout guard in
// createRedisConnection. Shared by the preference store and the GitHub read
// cache (lib/githubCacheStore), so one process holds one connection.
export interface RedisConnection {
  run<T>(command: (client: RedisClient) => Promise<T>): Promise<T>;
}

// The commands the stores issue, so callers do not depend on the client
// library's generic types.
export interface RedisClient {
  del(key: string): Promise<unknown>;
  eval(
    script: string,
    options: { arguments: string[]; keys: string[] }
  ): Promise<unknown>;
  evalSha(
    sha1: string,
    options: { arguments: string[]; keys: string[] }
  ): Promise<unknown>;
  get(key: string): Promise<string | null>;
  set(
    key: string,
    value: string,
    options?: { expiration: { type: 'EX'; value: number } }
  ): Promise<unknown>;
}

let redisConnectionPromise: Promise<RedisConnection> | undefined;
let storeOverride: { store: PreferenceStore | undefined } | undefined;

// Lets tests substitute an in-memory store (or force "disabled" with
// undefined) without a Redis server or Worker. Pass null to restore normal
// selection. Production never calls this.
export function setPreferenceStoreOverride(
  store: PreferenceStore | undefined | null
): void {
  storeOverride = store === null ? undefined : { store };
}

export async function getPreferenceStore(): Promise<
  PreferenceStore | undefined
> {
  if (storeOverride != null) {
    return storeOverride.store;
  }
  const connection = getRedisConnection();
  if (connection != null) {
    const { run } = await connection;
    return {
      async delete(key) {
        await run((client) => client.del(key));
      },
      get: (key) => run((client) => client.get(key)),
      async put(key, value, options) {
        const ttl = options?.expirationTtl;
        await run((client) =>
          ttl == null
            ? client.set(key, value)
            : client.set(key, value, { expiration: { type: 'EX', value: ttl } })
        );
      },
    };
  }
  return await readCloudflareKVBinding();
}

// The process's Redis connection when DIFFSHUB_REDIS_URL is set, created on
// first use; undefined otherwise.
export function getRedisConnection(): Promise<RedisConnection> | undefined {
  const redisURL = getRedisURL();
  if (redisURL == null) {
    return undefined;
  }
  redisConnectionPromise ??= createRedisConnection(redisURL, () => {
    redisConnectionPromise = undefined;
  });
  return redisConnectionPromise;
}

// Connection URL for the Redis/Valkey store from DIFFSHUB_REDIS_URL, e.g.
// redis://valkey:6379 or rediss://:password@host:6380/0. Blank counts as
// unset. Applies the same rules as the client's own URL parser (scheme,
// percent-escaped credentials, numeric database path), so a value the client
// would refuse fails the health check instead of every preferences request.
function getRedisURL(): string | undefined {
  const url = readNonEmptyString(process.env.DIFFSHUB_REDIS_URL);
  if (url == null) {
    return undefined;
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('DIFFSHUB_REDIS_URL is not a valid URL.');
  }
  if (parsed.protocol !== 'redis:' && parsed.protocol !== 'rediss:') {
    throw new Error(
      'DIFFSHUB_REDIS_URL must use the redis:// or rediss:// scheme.'
    );
  }
  try {
    decodeURIComponent(parsed.username);
    decodeURIComponent(parsed.password);
  } catch {
    throw new Error(
      'DIFFSHUB_REDIS_URL has a malformed percent-escape in its credentials.'
    );
  }
  if (parsed.pathname.length > 1 && !/^\/\d+$/.test(parsed.pathname)) {
    throw new Error(
      'DIFFSHUB_REDIS_URL path must be a database number, e.g. redis://host:6379/0.'
    );
  }
  return url;
}

// Health checks and the startup banner call this so a malformed
// DIFFSHUB_REDIS_URL keeps the instance out of service.
export function validatePreferenceStoreConfiguration(): void {
  getRedisURL();
}

// Connects lazily on first use, so a deployment without preferences traffic
// never opens a socket. The offline queue is disabled: while Redis is down,
// commands fail immediately instead of piling up behind a reconnect. onBroken
// runs once if the client is torn down after a stall (see run).
async function createRedisConnection(
  url: string,
  onBroken: () => void
): Promise<RedisConnection> {
  const { createClient } = await import('@redis/client');
  const client = createClient({
    disableOfflineQueue: true,
    // A socket silent for the timeout is closed and redialed through the
    // reconnect strategy, which bounds a handshake the server never answers.
    // Pings keep an idle connection from tripping it; each waits for the
    // previous reply, so a stalled server goes quiet and trips it too.
    pingInterval: REDIS_COMMAND_TIMEOUT_MS / 3,
    socket: {
      connectTimeout: REDIS_COMMAND_TIMEOUT_MS,
      reconnectStrategy: (retries) => Math.min(retries * 200, 5000),
      socketTimeout: REDIS_COMMAND_TIMEOUT_MS,
    },
    url,
  });
  client.on('error', (error: unknown) => {
    emitLogLine({
      error: formatError(error),
      event: 'preference_store_error',
      level: 'error',
      store: 'redis',
    });
  });
  // The reconnect strategy keeps retrying a failed first connect, so this
  // promise settles once the server is first reachable.
  let connected = false;
  const firstConnect = client.connect().then(() => {
    connected = true;
  });
  firstConnect.catch(() => {});

  // Commands issued before the first connection completes wait for it (up to
  // the timeout) rather than hitting the disabled offline queue; a timeout
  // there leaves the client retrying with its backoff (socketTimeout redials a
  // stalled handshake). Once connected, steady request traffic keeps a stalled
  // socket active, so socketTimeout may never fire; a timeout then means the
  // server holds the socket open without replying while the client still
  // reports ready, and later commands would queue behind the stalled ones. The
  // client is destroyed, rejecting everything pending, and the next request
  // builds a fresh one.
  async function run<T>(
    command: (connected: RedisClient) => Promise<T>
  ): Promise<T> {
    try {
      if (!client.isReady) {
        await withTimeout(firstConnect);
      }
      return await withTimeout(command(client));
    } catch (error) {
      if (error instanceof StoreTimeoutError && connected && client.isOpen) {
        client.destroy();
        onBroken();
      }
      throw error;
    }
  }

  return { run };
}

// The KV binding, or undefined outside a Worker (Node standalone, tests) or
// when wrangler.toml does not declare it. Exported for the GitHub read cache,
// which shares the namespace under its own key prefix. Sync mode only reads the context the
// Worker entrypoint (or initOpenNextCloudflareForDev under `next dev`) already
// installed, and throws when there is none. Async mode is avoided on purpose:
// on Node it would start a Wrangler platform proxy and back production
// preferences with a local Miniflare store.
export async function readCloudflareKVBinding(): Promise<
  PreferenceStore | undefined
> {
  try {
    const { getCloudflareContext } = await import('@opennextjs/cloudflare');
    const env = getCloudflareContext().env as Record<string, unknown>;
    const binding = env.DIFFSHUB_PREFERENCES;
    return isPreferenceStore(binding) ? binding : undefined;
  } catch {
    return undefined;
  }
}

function isPreferenceStore(value: unknown): value is PreferenceStore {
  const store = value as Partial<PreferenceStore> | null | undefined;
  return (
    typeof store?.get === 'function' &&
    typeof store.put === 'function' &&
    typeof store.delete === 'function'
  );
}

class StoreTimeoutError extends Error {
  constructor() {
    super('Preference store did not respond in time.');
  }
}

function withTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new StoreTimeoutError());
    }, REDIS_COMMAND_TIMEOUT_MS);
  });
  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}
