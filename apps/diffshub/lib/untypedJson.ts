// Narrows an untyped JSON value to a plain record, or null for anything
// else. The first step of every parser over external API payloads; shared so
// each parser doesn't re-derive the cast.
export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value != null
    ? (value as Record<string, unknown>)
    : null;
}
