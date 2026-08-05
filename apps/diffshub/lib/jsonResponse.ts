// JSON responses for token-authenticated API routes: never cached, and keyed
// on the Authorization header so a shared cache cannot serve one user's
// response to another.
export function createJSONResponse(
  body: unknown,
  options: { status?: number } = {}
): Response {
  return Response.json(body, {
    status: options.status ?? 200,
    headers: {
      'Cache-Control': 'no-store',
      Vary: 'Authorization',
    },
  });
}
