// The GitHub token lives only in client-side localStorage, which the server
// can never see, so the token hook mirrors a presence-only cookie (a bare "1",
// never the token itself). Middleware reads it to route signed-in visitors
// from the static marketing hero to /pulls without a hydration flash.
export const TOKEN_PRESENCE_COOKIE = 'diffshub-has-token';

export function syncTokenPresenceCookie(hasToken: boolean): void {
  try {
    document.cookie = hasToken
      ? `${TOKEN_PRESENCE_COOKIE}=1; path=/; max-age=31536000; samesite=lax`
      : `${TOKEN_PRESENCE_COOKIE}=; path=/; max-age=0; samesite=lax`;
  } catch {
    // Cookies can be disabled; the landing redirect is then simply skipped.
  }
}
