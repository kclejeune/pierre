import { afterEach, beforeEach, describe, expect, test } from 'bun:test';

import { resetGitHubEnvironmentCache } from '../lib/githubEnvironment';
import { logStartupConfiguration } from '../lib/startupLog';
import { captureConsole, type CapturedLine } from './helpers/captureConsole';

const MANAGED = [
  'DIFFSHUB_GITHUB_URL',
  'DIFFSHUB_GITHUB_API_URL',
  'DIFFSHUB_GITHUB_RAW_URL',
  'DIFFSHUB_PUBLIC_ORIGIN',
  'DIFFSHUB_GITHUB_CLIENT_ID',
  'DIFFSHUB_GITHUB_CLIENT_SECRET',
  'DIFFSHUB_ENABLE_PAT_INPUT',
  'DIFFSHUB_REFRESH_TOKEN_MAX_TTL',
  'DIFFSHUB_TOKEN_ENCRYPTION_KEY',
  'DIFFSHUB_AVATAR_TOKEN',
  'DIFFSHUB_REQUIRE_LOGIN',
];
const ORIGINAL_ENV = new Map(
  MANAGED.map((key) => [key, process.env[key]] as const)
);

// A usable configuration goes to stdout, a broken one to stderr.
async function captureLine(): Promise<CapturedLine> {
  const [captured] = await captureConsole(logStartupConfiguration);
  if (captured == null) {
    throw new Error('logStartupConfiguration wrote nothing');
  }
  return captured;
}

async function capture(): Promise<Record<string, unknown>> {
  return JSON.parse((await captureLine()).line) as Record<string, unknown>;
}

describe('logStartupConfiguration', () => {
  beforeEach(() => {
    for (const key of MANAGED) {
      delete process.env[key];
    }
    resetGitHubEnvironmentCache();
  });

  afterEach(() => {
    for (const key of MANAGED) {
      const value = ORIGINAL_ENV.get(key);
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    resetGitHubEnvironmentCache();
  });

  // Indented and without the event/time/level envelope of the request logs, so a
  // person reading a boot log sees it as a banner rather than another entry.
  test('prints indented JSON with no log envelope', async () => {
    const { line } = await captureLine();

    expect(line).toContain('\n  "env": {');
    expect(line).not.toContain('"event"');
    expect(line).not.toContain('"level"');
    expect(line).not.toContain('"time"');
  });

  test('prints non-secret values and masks configured secrets', async () => {
    process.env.DIFFSHUB_GITHUB_URL = 'https://ghe.corp.dev';
    process.env.DIFFSHUB_GITHUB_CLIENT_ID = 'Iv1.abc123';
    process.env.DIFFSHUB_GITHUB_CLIENT_SECRET = 'super-secret-value';
    process.env.DIFFSHUB_AVATAR_TOKEN = 'ghp_avatar_secret';
    resetGitHubEnvironmentCache();

    const record = await capture();
    const env = record.env as Record<string, string | null>;

    expect(env.DIFFSHUB_GITHUB_URL).toBe('https://ghe.corp.dev');
    expect(env.DIFFSHUB_GITHUB_CLIENT_ID).toBe('Iv1.abc123');
    expect(env.DIFFSHUB_GITHUB_CLIENT_SECRET).toBe('*****');
    expect(env.DIFFSHUB_AVATAR_TOKEN).toBe('*****');

    const serialized = JSON.stringify(record);
    expect(serialized).not.toContain('super-secret-value');
    expect(serialized).not.toContain('ghp_avatar_secret');
  });

  test('reports an unset or blank variable as null', async () => {
    process.env.DIFFSHUB_AVATAR_TOKEN = '   ';
    const env = (await capture()).env as Record<string, string | null>;

    expect(env.DIFFSHUB_AVATAR_TOKEN).toBeNull();
    expect(env.DIFFSHUB_TOKEN_ENCRYPTION_KEY).toBeNull();
  });

  // The raw variables are mostly optional, so the resolved values are what say
  // which instance the process will actually talk to.
  test('includes the resolved instance and credential policy', async () => {
    process.env.DIFFSHUB_GITHUB_URL = 'https://ghe.corp.dev';
    resetGitHubEnvironmentCache();

    expect((await capture()).effective).toMatchObject({
      apiURL: 'https://ghe.corp.dev/api/v3',
      isGitHubDotCom: false,
      requireLogin: true,
      webURL: 'https://ghe.corp.dev',
    });
  });

  // A bad value must not make the startup log the thing that kills the process.
  test('reports a malformed instance URL instead of throwing', async () => {
    process.env.DIFFSHUB_GITHUB_URL = 'not a url';
    resetGitHubEnvironmentCache();

    const { line, stream } = await captureLine();
    const record = JSON.parse(line) as Record<string, unknown>;
    expect(stream).toBe('stderr');
    expect(String(record.effectiveError)).toContain('DIFFSHUB_GITHUB_URL');
    expect(record.effective).toBeUndefined();
  });
});
