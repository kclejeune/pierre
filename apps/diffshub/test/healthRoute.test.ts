import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { GET } from '../app/api/health/route';
import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';

const CONFIG_KEYS = [
  'DIFFSHUB_AVATAR_TOKEN',
  'DIFFSHUB_GITHUB_API_URL',
  'DIFFSHUB_GITHUB_CLIENT_ID',
  'DIFFSHUB_GITHUB_CLIENT_SECRET',
  'DIFFSHUB_GITHUB_RAW_URL',
  'DIFFSHUB_GITHUB_URL',
  'DIFFSHUB_PUBLIC_ORIGIN',
  'DIFFSHUB_REFRESH_TOKEN_MAX_TTL',
  'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
] as const;
const originalEnvironment = new Map(
  CONFIG_KEYS.map((key) => [key, process.env[key]] as const)
);

beforeEach(() => {
  for (const key of CONFIG_KEYS) {
    delete process.env[key];
  }
  resetGitHubEnvironmentCache();
});

afterEach(() => {
  for (const key of CONFIG_KEYS) {
    const value = originalEnvironment.get(key);
    if (value == null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  resetGitHubEnvironmentCache();
});

describe('/api/health', () => {
  test('reports a valid configuration as ready', async () => {
    const response = GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('rejects invalid static configuration', async () => {
    process.env.DIFFSHUB_PUBLIC_ORIGIN =
      'https://admin:super-secret@diffs.example.com';
    resetGitHubEnvironmentCache();

    const response = GET();
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({
      error: 'DiffsHub configuration is invalid.',
      status: 'error',
    });
    expect(JSON.stringify(body)).not.toContain('super-secret');
  });
});
