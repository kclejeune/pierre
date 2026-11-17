// GitHub refuses a GitHub App token outside its installation (org hasn't
// installed the app, or hasn't approved a permission) with this bare message.
const INTEGRATION_REFUSAL = /not accessible by integration/i;

// Who can fix a refusal, shared by every message that reports one.
export const GITHUB_APP_OWNER_FIX =
  'Ask an organization owner to install the app or approve its requested permissions.';

export function isGitHubAppRefusal(message: string): boolean {
  return INTEGRATION_REFUSAL.test(message);
}

// Rewrites an integration refusal into who can fix it, keeping GitHub's text;
// undefined for any other failure. `repo` is "owner/name" when known.
export function explainGitHubAppRefusal(
  detail: string,
  repo?: string
): string | undefined {
  if (!isGitHubAppRefusal(detail)) {
    return undefined;
  }
  return `The DiffsHub GitHub App can't access ${repo ?? 'this repository'}: its organization hasn't installed the app, or the installation is missing a permission this action needs. ${GITHUB_APP_OWNER_FIX} (GitHub: ${detail})`;
}
