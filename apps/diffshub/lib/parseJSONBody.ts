// The JSON object body of a request, or null when the body is missing,
// malformed, or not an object — so route handlers can answer 400 without a
// try/catch of their own.
export async function parseJSONBody(request: {
  json(): Promise<unknown>;
}): Promise<Record<string, unknown> | null> {
  try {
    const payload = await request.json();
    return typeof payload === 'object' && payload != null
      ? (payload as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}
