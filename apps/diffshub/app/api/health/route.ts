// Liveness probe for container orchestrators (ECS/ALB target groups, App
// Runner, docker-compose healthcheck). Deliberately minimal: it does not call
// GitHub or check configuration, so a GitHub outage or a misconfigured
// DIFFSHUB_* value never takes the instance out of rotation — those surface in
// the app itself. It is also exempt from the login gate, which other routes
// opt into per handler, because probes carry no token.
export function GET() {
  return Response.json(
    { status: 'ok' },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}
