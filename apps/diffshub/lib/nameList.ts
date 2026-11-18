// Case-insensitive lists of GitHub names (repositories, logins) as the
// per-feature preference stores keep them: GitHub treats names
// case-insensitively, so membership, de-duplication, and removal ignore case
// while the stored entries keep the casing they were added with.

export function includesName(list: readonly string[], name: string): boolean {
  const needle = name.toLowerCase();
  return list.some((entry) => entry.toLowerCase() === needle);
}

export function withoutName(list: readonly string[], name: string): string[] {
  const needle = name.toLowerCase();
  return list.filter((entry) => entry.toLowerCase() !== needle);
}

// Reads a stored list: strings `isValid` accepts, de-duplicated keeping the
// first, capped at `max`. Anything that isn't an array reads as empty.
export function parseNameList(
  value: unknown,
  isValid: (name: string) => boolean,
  max: number
): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const names: string[] = [];
  for (const entry of value) {
    if (
      typeof entry === 'string' &&
      isValid(entry) &&
      !includesName(names, entry)
    ) {
      names.push(entry);
    }
    if (names.length >= max) {
      break;
    }
  }
  return names;
}
