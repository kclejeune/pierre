import { describe, expect, test } from 'bun:test';

import {
  DEFAULT_BOT_LOGIN_PATTERNS,
  isLikelyBotAuthor,
  matchesMutedBranch,
  parseBotLoginPatterns,
  parseBranchMutePresets,
  parseMuteRules,
  parseStaleDuration,
  resolveStaleAfter,
  staleCutoff,
} from '../lib/muteRules';

describe('parseStaleDuration', () => {
  test('reads short and long units', () => {
    expect(parseStaleDuration('36h')).toEqual({ amount: 36, unit: 'h' });
    expect(parseStaleDuration('60d')).toEqual({ amount: 60, unit: 'd' });
    expect(parseStaleDuration('2 weeks')).toEqual({ amount: 2, unit: 'w' });
    expect(parseStaleDuration('3MO')).toEqual({ amount: 3, unit: 'mo' });
    expect(parseStaleDuration('1 year')).toEqual({ amount: 1, unit: 'y' });
    expect(parseStaleDuration('off')).toBe('off');
  });

  test('rejects ambiguous or malformed input', () => {
    expect(parseStaleDuration('5m')).toBeUndefined();
    expect(parseStaleDuration('0d')).toBeUndefined();
    expect(parseStaleDuration('d')).toBeUndefined();
    expect(parseStaleDuration('soon')).toBeUndefined();
  });
});

describe('staleCutoff', () => {
  const now = new Date('2026-11-19T17:42:10Z');
  test('hours keep the time, floored to the hour', () => {
    expect(staleCutoff({ amount: 6, unit: 'h' }, now)).toBe(
      '2026-11-19T11:00:00Z'
    );
  });
  test('longer durations use the UTC date', () => {
    expect(staleCutoff({ amount: 60, unit: 'd' }, now)).toBe('2026-09-20');
    expect(staleCutoff({ amount: 2, unit: 'w' }, now)).toBe('2026-11-05');
    expect(staleCutoff({ amount: 3, unit: 'mo' }, now)).toBe('2026-08-19');
  });

  test('clamps month and year cutoffs to the target month', () => {
    const endOfMarch = new Date('2026-03-31T12:00:00Z');
    expect(staleCutoff({ amount: 1, unit: 'mo' }, endOfMarch)).toBe(
      '2026-02-28'
    );
    const leapDay = new Date('2028-02-29T12:00:00Z');
    expect(staleCutoff({ amount: 1, unit: 'y' }, leapDay)).toBe('2027-02-28');
    expect(staleCutoff({ amount: 1, unit: 'y' }, now)).toBe('2025-11-19');
  });
});

test('the viewer pick overrides the deployment default, and off disables', () => {
  expect(resolveStaleAfter({ branches: [] }, '60d')).toEqual({
    amount: 60,
    unit: 'd',
  });
  expect(resolveStaleAfter({ branches: [], staleAfter: '2w' }, '60d')).toEqual({
    amount: 2,
    unit: 'w',
  });
  expect(
    resolveStaleAfter({ branches: [], staleAfter: 'off' }, '60d')
  ).toBeUndefined();
  expect(resolveStaleAfter({ branches: [] }, 'off')).toBeUndefined();
});

test('stored rules keep valid branches and canonical durations only', () => {
  expect(
    parseMuteRules({
      branches: ['renovate', 'Renovate', 'bad prefix', 'release-bot/'],
      staleAfter: '2 weeks',
    })
  ).toEqual({ branches: ['renovate', 'release-bot/'], staleAfter: '2w' });
  expect(parseMuteRules('nope')).toEqual({ branches: [] });
});

test('branch matching is a case-insensitive prefix, like head:', () => {
  expect(matchesMutedBranch(['renovate'], 'Renovate/foo-1.x')).toBe(true);
  expect(matchesMutedBranch(['renovate'], 'feature/renovate')).toBe(false);
  expect(matchesMutedBranch(['renovate'], undefined)).toBe(false);
});

describe('deployment presets', () => {
  test('branch presets read Label=prefix pairs and bare prefixes', () => {
    expect(
      parseBranchMutePresets(
        'Renovate=renovate, Cherry-picks=cherrypick,auto-bump,bad=has space'
      )
    ).toEqual([
      { label: 'Renovate', prefix: 'renovate' },
      { label: 'Cherry-picks', prefix: 'cherrypick' },
      { label: 'auto-bump', prefix: 'auto-bump' },
    ]);
    expect(parseBranchMutePresets(undefined)).toBeUndefined();
    expect(parseBranchMutePresets(' , ')).toBeUndefined();
  });

  test('bot login globs match machine users; App bots always count', () => {
    const patterns = DEFAULT_BOT_LOGIN_PATTERNS;
    expect(isLikelyBotAuthor({ authorLogin: 'renovate-bot' }, patterns)).toBe(
      true
    );
    expect(isLikelyBotAuthor({ authorLogin: 'ci_bot' }, patterns)).toBe(true);
    expect(
      isLikelyBotAuthor({ authorLogin: 'dependabot[bot]' }, patterns)
    ).toBe(true);
    expect(isLikelyBotAuthor({ authorLogin: 'robotics-ann' }, patterns)).toBe(
      false
    );
    expect(
      isLikelyBotAuthor({ authorIsBot: true, authorLogin: 'witness' }, patterns)
    ).toBe(true);
    const custom = parseBotLoginPatterns('*-bot, release-pd') ?? [];
    expect(isLikelyBotAuthor({ authorLogin: 'Release-PD' }, custom)).toBe(true);
    expect(parseBotLoginPatterns('')).toBeUndefined();
  });
});
