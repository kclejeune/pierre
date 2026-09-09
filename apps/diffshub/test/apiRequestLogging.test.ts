import { Glob } from 'bun';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Request logging is opt-in per route file (see lib/requestLog for why it cannot
// live in middleware), so nothing stops a new route from shipping unlogged.
// This asserts the convention instead: every exported HTTP method goes through
// withRequestLog. Add a route to EXEMPT only with a comment saying why.
const API_DIRECTORY = join(import.meta.dir, '..', 'app', 'api');

// The readiness probe is polled every few seconds, so a log line per hit would
// be noise. Configuration failures are emitted by the startup logger.
const EXEMPT = new Set(['health/route.ts']);

const HTTP_METHODS = ['DELETE', 'GET', 'PATCH', 'POST', 'PUT'];

describe('api route request logging', () => {
  test('every exported handler is wrapped in withRequestLog', () => {
    const unwrapped: string[] = [];
    for (const relativePath of new Glob('**/route.ts').scanSync(
      API_DIRECTORY
    )) {
      const normalized = relativePath.split('\\').join('/');
      if (EXEMPT.has(normalized)) {
        continue;
      }
      const source = readFileSync(join(API_DIRECTORY, relativePath), 'utf8');
      for (const method of HTTP_METHODS) {
        const exported = new RegExp(
          `^export\\s+(?:const|async function|function)\\s+${method}\\b`,
          'm'
        ).exec(source);
        if (exported == null) {
          continue;
        }
        if (!source.includes(`export const ${method} = withRequestLog(`)) {
          unwrapped.push(`${normalized} ${method}`);
        }
      }
    }

    expect(unwrapped).toEqual([]);
  });
});
