// JSON responses for token-authenticated API routes: never cached by default,
// and keyed on the Authorization header so a shared cache cannot serve one
// user's response to another. Routes serving immutable payloads (content
// pinned to a commit sha) may override Cache-Control via `headers`.
export function createJSONResponse(
  body: unknown,
  options: { headers?: Record<string, string>; status?: number } = {}
): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      Vary: 'Authorization',
      ...options.headers,
    },
  });
}
