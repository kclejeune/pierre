import { type NextRequest } from 'next/server';

import type { AppInstallationsPayload } from '@/lib/appPermissions';
import { loadAppInstallations } from '@/lib/githubAppInstallations';
import { commitErrorResponse } from '@/lib/githubCommitServer';
import { rejectTokenlessRequestWhenLoginRequired } from '@/lib/githubEnvironment';
import { createPrivateJSONResponse } from '@/lib/jsonResponse';
import { withRequestLog } from '@/lib/requestLog';
import { resolveBearerToken } from '@/lib/resolveBearerToken';

// What the viewer's GitHub App sign-in may do in each org (see
// lib/appPermissions), so the UI can disable controls GitHub would refuse.
// Without a token, or with one no installation limits, the answer is null:
// nothing to restrict.
async function handleGET(request: NextRequest) {
  const rejection = rejectTokenlessRequestWhenLoginRequired(request);
  if (rejection != null) {
    return rejection;
  }
  const token = await resolveBearerToken(request);
  try {
    const payload: AppInstallationsPayload = {
      installations: token == null ? null : await loadAppInstallations(token),
    };
    return createPrivateJSONResponse(payload, 300);
  } catch (error) {
    return commitErrorResponse(error);
  }
}

export const GET = withRequestLog(handleGET);
