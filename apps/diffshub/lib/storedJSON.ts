// Defensive localStorage JSON access shared by the per-feature stores
// (reviewed-file marks, pending reviews): reads return null for missing or
// corrupt payloads, and writes swallow storage failures (private browsing,
// quota) so each feature degrades to session-only state instead of throwing.

export function readStoredJSON(key: string): unknown {
  try {
    const raw = window.localStorage.getItem(key);
    return raw == null ? null : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

// Writes the value as JSON, or removes the key entirely when null so an empty
// feature state leaves no residue behind.
export function writeStoredJSON(key: string, value: unknown): void {
  try {
    if (value == null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, JSON.stringify(value));
    }
  } catch {
    // Storage unavailable; state still holds for this session.
  }
}
