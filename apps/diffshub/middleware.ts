import { type NextRequest, NextResponse } from 'next/server';

import { TOKEN_PRESENCE_COOKIE } from '@/lib/tokenPresenceCookie';

// Signed-in visitors land on the /pulls dashboard instead of the anonymous
// marketing hero. The home page is statically prerendered and the GitHub
// token lives in client-only localStorage, so the client mirrors a
// presence-only cookie (see lib/tokenPresenceCookie.ts) that lets the edge
// branch here without a signed-in flash.
//
// This deliberately uses the deprecated middleware.ts convention instead of
// Next 16's proxy.ts: proxy runs on the Node runtime only, which
// @opennextjs/cloudflare cannot deploy (opennextjs-cloudflare#962). The
// middleware convention still builds as Edge middleware, which both Vercel
// and Workers support. Revert to proxy.ts once OpenNext supports it.
export function middleware(request: NextRequest) {
  if (request.cookies.get(TOKEN_PRESENCE_COOKIE)?.value === '1') {
    return NextResponse.redirect(new URL('/pulls', request.url));
  }
  return NextResponse.next();
}

export const config = { matcher: '/' };
