// Summary of how this instance is configured, logged at startup so a container's
// first log lines answer "what did it actually read?" without shelling in.
// Secrets are reported as configured-or-not, never by value.
//
// The table is explicit rather than a sweep of process.env: a variable added
// later is omitted until it is listed here, so a new secret can never be
// printed in the clear by default.

import {
  getGitHubEnvironment,
  isLoginRequired,
  isPATInputEnabled,
} from './githubEnvironment';
import { readNonEmptyString } from './githubOAuthGrant';
import { formatError } from './serverLog';

const SECRET_PLACEHOLDER = '*****';

interface ConfigVariable {
  name: string;
  // Report only whether it is set, never its value.
  secret?: boolean;
}

const CONFIG_VARIABLES: ConfigVariable[] = [
  { name: 'NODE_ENV' },
  { name: 'PORT' },
  { name: 'DIFFSHUB_GITHUB_URL' },
  { name: 'DIFFSHUB_GITHUB_API_URL' },
  { name: 'DIFFSHUB_GITHUB_RAW_URL' },
  { name: 'DIFFSHUB_PUBLIC_ORIGIN' },
  { name: 'DIFFSHUB_GITHUB_CLIENT_ID' },
  { name: 'DIFFSHUB_GITHUB_CLIENT_SECRET', secret: true },
  { name: 'DIFFSHUB_REQUIRE_LOGIN' },
  { name: 'DIFFSHUB_ENABLE_PAT_INPUT' },
  { name: 'DIFFSHUB_REFRESH_TOKEN_MAX_TTL' },
  { name: 'DIFFSHUB_TOKEN_ENCRYPTION_KEY', secret: true },
  { name: 'DIFFSHUB_AVATAR_TOKEN', secret: true },
  { name: 'NEXT_PUBLIC_WORKTREE_SLUG' },
];

// null means unset, so "explicitly empty" and "absent" read the same way they
// behave: readNonEmptyString is the same blank-is-unset rule every DIFFSHUB_*
// reader applies, so the banner cannot disagree with what they see.
function readConfigValue({ name, secret }: ConfigVariable): string | null {
  const value = readNonEmptyString(process.env[name]);
  if (value == null) {
    return null;
  }
  return secret === true ? SECRET_PLACEHOLDER : value;
}

// Most DIFFSHUB_* variables are optional and their defaults are derived, so the
// raw values alone do not say what the instance will do. This is the resolved
// answer: which instance it talks to and which credential policies are on.
function readEffectiveConfig(): Record<string, unknown> {
  const environment = getGitHubEnvironment();
  return {
    apiURL: environment.apiURL,
    isGitHubDotCom: environment.isGitHubDotCom,
    patInputEnabled: isPATInputEnabled(),
    rawURL: environment.rawURL,
    requireLogin: isLoginRequired(),
    webURL: environment.webURL,
  };
}

export function logStartupConfiguration(): void {
  const env: Record<string, string | null> = {};
  for (const variable of CONFIG_VARIABLES) {
    env[variable.name] = readConfigValue(variable);
  }

  // Deliberately without the event/time/level envelope the request logs carry:
  // this is a one-off banner describing the process, not an event in a stream,
  // and dropping the envelope is what makes it read as a different kind of
  // thing. env keeps CONFIG_VARIABLES order so related variables stay together.
  const record: Record<string, unknown> = { env };
  let failed = false;
  try {
    record.effective = readEffectiveConfig();
  } catch (error) {
    // A malformed DIFFSHUB_GITHUB_URL throws here. Report it instead of letting
    // the startup log be the thing that takes the process down.
    record.effectiveError = formatError(error);
    failed = true;
  }
  // Indented, unlike the one-line-per-entry request logs: this is read once by a
  // person checking a container came up correctly. The cost is that JSON-lines
  // collectors see it as several entries, which is a fair trade for one record
  // at startup. A broken configuration goes to stderr, where failures belong.
  const serialized = JSON.stringify(record, null, 2);
  if (failed) {
    console.error(serialized);
  } else {
    console.log(serialized);
  }
}
