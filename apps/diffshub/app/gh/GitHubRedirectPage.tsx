import { permanentRedirect } from 'next/navigation';

// Legacy alias that just sends visitors to the home page. The target is a
// relative path rather than an absolute diffshub.com URL: on the public
// deployment both land in the same place, but an absolute one would bounce a
// self-hosted install out to the public internet, which for a deployment
// inside a network boundary is egress it never asked for.
export function GitHubRedirectPage() {
  permanentRedirect('/');
}
