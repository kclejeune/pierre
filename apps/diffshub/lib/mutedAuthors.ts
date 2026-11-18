// Pull request authors the viewer has muted on the /pulls dashboard, stored
// as one localStorage array of GitHub search author names: "app/renovate" for
// GitHub App bots (the form author: qualifiers take for them) and plain
// logins for users, including machine accounts. The dashboard leaves their
// pulls out of the list with -author: exclusions, so bot traffic (dependency
// bumps, release automation) stops burying pulls from people. Stored as a
// synced preference (lib/preferenceSync) so the list follows signed-in
// viewers across browsers, and saves broadcast a window event like pins do.

import { includesName, parseNameList, withoutName } from './nameList';
import { readSyncedItem, writeSyncedItem } from './preferenceSync';

// Each muted author adds an exclusion to every search; this keeps the query
// well inside GitHub's search length limits.
export const MAX_MUTED_AUTHORS = 20;
export const MUTED_AUTHORS_EVENT = 'diffshub:muted-authors';

// A GitHub login (alphanumerics and single inner hyphens, which GHE also
// extends with underscores for managed users), optionally as an app/ bot.
const AUTHOR_PATTERN = /^(app\/)?[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;

export function isValidMutedAuthor(author: string): boolean {
  return AUTHOR_PATTERN.test(author);
}

// The author: qualifier value that finds a pull's author: bots (GitHub Apps)
// search as app/<slug>, everyone else by login.
export function authorSearchName(author: {
  authorIsBot?: boolean;
  authorLogin?: string;
}): string | undefined {
  if (author.authorLogin == null) {
    return undefined;
  }
  // App logins can carry REST's "[bot]" suffix (dependabot[bot]); the
  // app/ search form takes the bare slug.
  return author.authorIsBot === true
    ? `app/${author.authorLogin.replace(/\[bot\]$/i, '')}`
    : author.authorLogin;
}

// The name shown for a muted author: the login, without the app/ prefix.
export function mutedAuthorLabel(author: string): string {
  return author.startsWith('app/') ? author.slice('app/'.length) : author;
}

export function isAuthorMuted(
  muted: readonly string[],
  author: string
): boolean {
  return includesName(muted, author);
}

// Reads a stored list: valid names only, de-duplicated case-insensitively,
// capped at MAX_MUTED_AUTHORS.
export function parseMutedAuthors(value: unknown): string[] {
  return parseNameList(value, isValidMutedAuthor, MAX_MUTED_AUTHORS);
}

export function loadMutedAuthors(): string[] {
  const raw = readSyncedItem('mutedAuthors');
  if (raw == null || raw === '') {
    return [];
  }
  try {
    return parseMutedAuthors(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function saveMutedAuthors(authors: readonly string[]): void {
  writeSyncedItem('mutedAuthors', JSON.stringify(authors));
  window.dispatchEvent(new CustomEvent(MUTED_AUTHORS_EVENT));
}

// Adds the authors not already muted, in order, up to the cap.
export function addMutedAuthors(
  muted: readonly string[],
  authors: readonly string[]
): string[] {
  return parseMutedAuthors([...muted, ...authors]);
}

export function removeMutedAuthor(
  muted: readonly string[],
  author: string
): string[] {
  return withoutName(muted, author);
}
