import { validateGitHubConfiguration } from '@/lib/githubEnvironment';
import { createJSONResponse } from '@/lib/jsonResponse';

// Readiness probe for container orchestrators (ECS/ALB target groups, App
// Runner, docker-compose healthcheck). It validates static configuration but
// does not call GitHub, so an upstream outage does not remove every instance.
// It is exempt from the login gate because probes carry no token.
//
// The only route not wrapped in withRequestLog: a log line per probe every few
// seconds would be noise. Invalid configuration is already emitted at startup.
export function GET() {
  try {
    validateGitHubConfiguration();
  } catch {
    return createJSONResponse(
      { error: 'DiffsHub configuration is invalid.', status: 'error' },
      { status: 503 }
    );
  }
  return createJSONResponse({ status: 'ok' });
}
