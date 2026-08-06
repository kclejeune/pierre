import { type NextRequest, NextResponse } from 'next/server';

import { TOKEN_PRESENCE_COOKIE } from '@/lib/tokenPresenceCookie';

// Signed-in visitors land on the /pulls dashboard instead of the anonymous
// marketing hero. The home page is statically prerendered and the GitHub
// token lives in client-only localStorage, so the client mirrors a
// presence-only cookie (see lib/tokenPresenceCookie.ts) that lets the edge
// branch here without a signed-in flash.
export function proxy(request: NextRequest) {
  if (request.cookies.get(TOKEN_PRESENCE_COOKIE)?.value === '1') {
    return NextResponse.redirect(new URL('/pulls', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: '/' };
