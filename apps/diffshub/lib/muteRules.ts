// The /pulls dashboard's muting beyond authors (lib/mutedAuthors): branch
// prefixes, which leave out automation pulls by the branch they come from
// (`-head:renovate` covers every renovate/... branch, whichever account
// opened it), and staleness, which leaves out open pulls nobody has touched
// in a while (`updated:>=<cutoff>`). Both are search terms, so the list's
// counts and pagination stay exact. The viewer's choices are stored as one
// synced preference (lib/preferenceSync), like muted authors.
//
// The presets are deployment-configurable (lib/githubEnvironment): the
// built-in ones only name what holds on any GitHub instance, the default
// branch prefixes of Renovate and Dependabot and the usual bot login
// suffixes. Organization-specific automation (a machine user called
// `release-pd`, an `armory/` branch convention) belongs in the deployment's
// configuration instead.

import { includesName, parseNameList, withoutName } from './nameList';
import { readSyncedItem, writeSyncedItem } from './preferenceSync';

export const MUTE_RULES_EVENT = 'diffshub:mute-rules';

// Each branch prefix adds a -head: term to every search, like a muted
// author, so the list stays well inside GitHub's query length limits.
export const MAX_MUTED_BRANCHES = 10;

// A branch name's leading segment: what GitHub's head: qualifier matches as
// a prefix (head:renovate finds renovate/foo and renovate-bar alike).
const BRANCH_PREFIX_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;

export function isValidBranchPrefix(prefix: string): boolean {
  return BRANCH_PREFIX_PATTERN.test(prefix);
}

// The viewer's muting choices besides authors. `staleAfter` is a canonical
// duration (see parseStaleDuration) or 'off'; absent means the deployment's
// default applies.
export interface MuteRules {
  branches: string[];
  staleAfter?: string;
}

export function parseMuteRules(value: unknown): MuteRules {
  if (typeof value !== 'object' || value == null) {
    return { branches: [] };
  }
  const record = value as Record<string, unknown>;
  const rules: MuteRules = {
    branches: parseNameList(
      record.branches,
      isValidBranchPrefix,
      MAX_MUTED_BRANCHES
    ),
  };
  if (typeof record.staleAfter === 'string') {
    const parsed = parseStaleDuration(record.staleAfter);
    if (parsed != null) {
      rules.staleAfter = formatStaleDuration(parsed);
    }
  }
  return rules;
}

export function loadMuteRules(): MuteRules {
  const raw = readSyncedItem('muteRules');
  if (raw == null || raw === '') {
    return { branches: [] };
  }
  try {
    return parseMuteRules(JSON.parse(raw));
  } catch {
    return { branches: [] };
  }
}

export function saveMuteRules(rules: MuteRules): void {
  writeSyncedItem('muteRules', JSON.stringify(parseMuteRules(rules)));
  window.dispatchEvent(new CustomEvent(MUTE_RULES_EVENT));
}

export function addMutedBranch(rules: MuteRules, prefix: string): MuteRules {
  return {
    ...rules,
    branches: parseNameList(
      [...rules.branches, prefix],
      isValidBranchPrefix,
      MAX_MUTED_BRANCHES
    ),
  };
}

export function removeMutedBranch(rules: MuteRules, prefix: string): MuteRules {
  return { ...rules, branches: withoutName(rules.branches, prefix) };
}

export function isBranchMuted(
  branches: readonly string[],
  prefix: string
): boolean {
  return includesName(branches, prefix);
}

// Whether a pull's head branch falls under a muted prefix, matched the way
// GitHub's head: qualifier does (a case-insensitive prefix).
export function matchesMutedBranch(
  branches: readonly string[],
  headRefName: string | undefined
): boolean {
  if (headRefName == null) {
    return false;
  }
  const head = headRefName.toLowerCase();
  return branches.some((prefix) => head.startsWith(prefix.toLowerCase()));
}

// Durations -----------------------------------------------------------------

export type StaleUnit = 'h' | 'd' | 'w' | 'mo' | 'y';

export interface StaleDuration {
  amount: number;
  unit: StaleUnit;
}

const UNIT_ALIASES: Record<string, StaleUnit> = {
  h: 'h',
  hr: 'h',
  hrs: 'h',
  hour: 'h',
  hours: 'h',
  d: 'd',
  day: 'd',
  days: 'd',
  w: 'w',
  wk: 'w',
  wks: 'w',
  week: 'w',
  weeks: 'w',
  mo: 'mo',
  mos: 'mo',
  month: 'mo',
  months: 'mo',
  y: 'y',
  yr: 'y',
  yrs: 'y',
  year: 'y',
  years: 'y',
};

const UNIT_NAMES: Record<StaleUnit, string> = {
  h: 'hour',
  d: 'day',
  w: 'week',
  mo: 'month',
  y: 'year',
};

// Reads a typed staleness duration: an amount and a unit, written short or
// long ("36h", "60d", "2 weeks", "3mo", "1 year"), or "off". A bare "m" is
// rejected rather than guessed (minutes or months). Undefined when the text
// is neither.
export function parseStaleDuration(
  text: string
): StaleDuration | 'off' | undefined {
  const trimmed = text.trim().toLowerCase();
  if (trimmed === 'off' || trimmed === 'never') {
    return 'off';
  }
  const match = /^(\d{1,4})\s*([a-z]+)$/.exec(trimmed);
  if (match == null) {
    return undefined;
  }
  const amount = Number(match[1]);
  const unit = UNIT_ALIASES[match[2] ?? ''];
  if (unit == null || amount < 1) {
    return undefined;
  }
  return { amount, unit };
}

export function formatStaleDuration(duration: StaleDuration | 'off'): string {
  return duration === 'off' ? 'off' : `${duration.amount}${duration.unit}`;
}

// "60 days", "1 week": how menus name a duration.
export function describeStaleDuration(duration: StaleDuration): string {
  const name = UNIT_NAMES[duration.unit];
  return `${duration.amount} ${name}${duration.amount === 1 ? '' : 's'}`;
}

// The oldest update a pull can have and still count as fresh, as the value
// of an `updated:>=` search term. Hour durations keep the time (floored to
// the hour); longer ones use the UTC date, which GitHub reads as that whole
// day. Rounding keeps the term, and so the server's page cache key and the
// search's results, steady between page loads.
export function staleCutoff(duration: StaleDuration, now: Date): string {
  const cutoff = new Date(now.getTime());
  switch (duration.unit) {
    case 'h':
      cutoff.setUTCMinutes(0, 0, 0);
      cutoff.setUTCHours(cutoff.getUTCHours() - duration.amount);
      return `${cutoff.toISOString().slice(0, 19)}Z`;
    case 'd':
      cutoff.setUTCDate(cutoff.getUTCDate() - duration.amount);
      break;
    case 'w':
      cutoff.setUTCDate(cutoff.getUTCDate() - duration.amount * 7);
      break;
    case 'mo':
      subtractUTCMonths(cutoff, duration.amount);
      break;
    case 'y':
      subtractUTCMonths(cutoff, duration.amount * 12);
      break;
  }
  return cutoff.toISOString().slice(0, 10);
}

// Moves `date` back `months` calendar months, keeping its day of the month
// but clamping it to the target month's last day. setUTCMonth alone rolls
// an impossible day forward (1 month before March 31 lands on March 3), which
// would hide pulls updated in the days it skips.
function subtractUTCMonths(date: Date, months: number): void {
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() - months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
}

// The staleness the viewer's list uses: their own pick, else the
// deployment's default; undefined when staleness muting is off.
export function resolveStaleAfter(
  rules: MuteRules,
  deploymentDefault: string
): StaleDuration | undefined {
  const parsed = parseStaleDuration(rules.staleAfter ?? deploymentDefault);
  return parsed == null || parsed === 'off' ? undefined : parsed;
}

// Presets --------------------------------------------------------------------

// A one-click branch mute the dashboard offers: a name and the prefix it
// mutes.
export interface BranchMutePreset {
  label: string;
  prefix: string;
}

// The branch prefixes Renovate and Dependabot use unless configured
// otherwise, the same on any GitHub instance.
export const DEFAULT_BRANCH_MUTE_PRESETS: readonly BranchMutePreset[] = [
  { label: 'Renovate', prefix: 'renovate' },
  { label: 'Dependabot', prefix: 'dependabot' },
];

// Logins that read as automation: GitHub Apps' "[bot]" suffix and the usual
// machine-user conventions. `*` matches any run of characters.
export const DEFAULT_BOT_LOGIN_PATTERNS: readonly string[] = [
  '*[bot]',
  '*-bot',
  '*_bot',
];

export const DEFAULT_STALE_AFTER = '60d';

// The muting presets of a deployment that configures none
// (lib/githubEnvironment getPullMutingConfig).
export const DEFAULT_PULL_MUTING_CONFIG = {
  botLoginPatterns: DEFAULT_BOT_LOGIN_PATTERNS,
  branchPresets: DEFAULT_BRANCH_MUTE_PRESETS,
  defaultStaleAfter: DEFAULT_STALE_AFTER,
} as const;

// Reads DIFFSHUB_MUTE_BRANCH_PRESETS: comma-separated `Label=prefix` pairs
// (a bare prefix is its own label). Invalid entries are dropped; undefined
// when the variable is unset or nothing in it is valid, so the built-ins
// apply.
export function parseBranchMutePresets(
  value: string | undefined
): BranchMutePreset[] | undefined {
  const presets: BranchMutePreset[] = [];
  for (const entry of (value ?? '').split(',')) {
    const [rawLabel, rawPrefix] = entry.includes('=')
      ? entry.split('=', 2)
      : [entry, entry];
    const label = rawLabel?.trim() ?? '';
    const prefix = rawPrefix?.trim() ?? '';
    if (
      label !== '' &&
      label.length <= 40 &&
      isValidBranchPrefix(prefix) &&
      !presets.some((preset) => includesName([preset.prefix], prefix))
    ) {
      presets.push({ label, prefix });
    }
  }
  return presets.length === 0
    ? undefined
    : presets.slice(0, MAX_MUTED_BRANCHES);
}

// Reads DIFFSHUB_BOT_LOGIN_PATTERNS: comma-separated login globs. Undefined
// when unset or empty, so the built-ins apply.
export function parseBotLoginPatterns(
  value: string | undefined
): string[] | undefined {
  const patterns = (value ?? '')
    .split(',')
    .map((pattern) => pattern.trim())
    .filter((pattern) => /^[A-Za-z0-9*_[\]/-]{1,60}$/.test(pattern));
  return patterns.length === 0 ? undefined : patterns.slice(0, 50);
}

// Whether a login matches one of the bot globs, case-insensitively.
export function matchesBotLoginPattern(
  login: string,
  patterns: readonly string[]
): boolean {
  return compileBotLoginPatterns(patterns).test(login);
}

// The bot globs as one anchored, case-insensitive alternation, compiled once
// per patterns list (the deployment's config, a stable array), since the
// dashboard checks every loaded pull's author against it.
const compiledBotPatterns = new WeakMap<readonly string[], RegExp>();

function compileBotLoginPatterns(patterns: readonly string[]): RegExp {
  let compiled = compiledBotPatterns.get(patterns);
  if (compiled == null) {
    const alternatives = patterns.map((pattern) =>
      pattern
        .split('*')
        .map((part) => part.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&'))
        .join('.*')
    );
    // An empty list matches nothing.
    compiled =
      alternatives.length === 0
        ? /(?!)/
        : new RegExp(`^(?:${alternatives.join('|')})$`, 'i');
    compiledBotPatterns.set(patterns, compiled);
  }
  return compiled;
}

// Whether a pull's author is automation: a GitHub App bot, or a machine user
// whose login matches the deployment's bot patterns.
export function isLikelyBotAuthor(
  pull: { authorIsBot?: boolean; authorLogin?: string },
  patterns: readonly string[]
): boolean {
  if (pull.authorIsBot === true) {
    return true;
  }
  return (
    pull.authorLogin != null &&
    matchesBotLoginPattern(pull.authorLogin, patterns)
  );
}
