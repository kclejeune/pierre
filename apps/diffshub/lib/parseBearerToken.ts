// Extracts the token from an `Authorization: Bearer <token>` header value.
// Returns undefined for missing, malformed, or empty headers.
export function parseBearerToken(value: string | null): string | undefined {
  if (value == null) {
    return undefined;
  }

  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  const token = match?.[1]?.trim();
  return token == null || token === '' ? undefined : token;
}
