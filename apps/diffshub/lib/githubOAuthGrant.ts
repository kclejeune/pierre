// The wire contract for a GitHub user access token grant, shared by the
// server routes that obtain one and the browser code that stores it.
//
// OAuth Apps and GitHub Apps without token expiration return only the access
// token; GitHub Apps with "Expire user authorization tokens" enabled add an
// 8-hour lifetime and a refresh token (itself six months), with which a
// session can mint the next access token without sending the user back
// through authorization. Lifetimes are kept relative (seconds, as GitHub
// reports them) so the browser can anchor them to its own clock.
export interface OAuthTokenGrant {
  accessToken: string;
  expiresIn?: number;
  refreshToken?: string;
  refreshTokenExpiresIn?: number;
}

// One parser for every transport a grant travels over — GitHub's token
// endpoint body, the OAuth completion fragment, the refresh route's JSON —
// all spelled with GitHub's own snake_case names. Returns undefined when no
// access token is present.
export function parseGrantRecord(
  record: Record<string, unknown>
): OAuthTokenGrant | undefined {
  const accessToken = readNonEmptyString(record.access_token);
  if (accessToken == null) {
    return undefined;
  }
  return {
    accessToken,
    expiresIn: parseSeconds(record.expires_in),
    refreshToken: readNonEmptyString(record.refresh_token),
    refreshTokenExpiresIn: parseSeconds(record.refresh_token_expires_in),
  };
}

// The inverse of parseGrantRecord, as strings so the result can feed either
// URLSearchParams or a JSON body.
export function serializeGrantRecord(
  grant: OAuthTokenGrant
): Record<string, string> {
  const record: Record<string, string> = { access_token: grant.accessToken };
  if (grant.expiresIn != null) {
    record.expires_in = String(grant.expiresIn);
  }
  if (grant.refreshToken != null) {
    record.refresh_token = grant.refreshToken;
  }
  if (grant.refreshTokenExpiresIn != null) {
    record.refresh_token_expires_in = String(grant.refreshTokenExpiresIn);
  }
  return record;
}

// Parses a completion-page fragment (with or without the leading '#').
export function parseGrantFragment(hash: string): OAuthTokenGrant | undefined {
  return parseGrantRecord(
    Object.fromEntries(new URLSearchParams(hash.replace(/^#/, '')))
  );
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined;
}

function parseSeconds(value: unknown): number | undefined {
  const seconds =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value !== ''
        ? Number(value)
        : NaN;
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}
