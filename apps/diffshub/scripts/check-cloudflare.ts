import assert from 'node:assert/strict';

// Exercise the deployed bundle in workerd: a successful Next build alone does
// not catch adapter incompatibilities that crash during server initialization.
// Use Wrangler's API to avoid CLI update checks, and disable its telemetry.
process.env.WRANGLER_SEND_METRICS = 'false';
const { unstable_dev } = await import('wrangler');
const worker = await unstable_dev('.open-next/worker.js', {
  config: 'wrangler.toml',
  local: true,
  port: 0,
  inspectorPort: 0,
  persist: false,
  logLevel: 'error',
  // Production's OAuth client ID has no matching secret in offline tests.
  // These probes use anonymous configuration and never contact GitHub.
  vars: { DIFFSHUB_GITHUB_CLIENT_ID: '' },
  experimental: {
    forceLocal: true,
    disableDevRegistry: true,
    disableExperimentalWarning: true,
    watch: false,
  },
});

try {
  const health = await worker.fetch('http://localhost/api/health', {
    signal: AbortSignal.timeout(20_000),
    redirect: 'manual',
  });
  const healthBody = await health.text();
  assert.equal(health.status, 200, `Worker health failed: ${healthBody}`);
  assert.deepEqual(JSON.parse(healthBody), { status: 'ok' });

  const home = await worker.fetch('http://localhost/', {
    signal: AbortSignal.timeout(20_000),
    redirect: 'manual',
  });
  const homeBody = await home.text();
  assert.equal(home.status, 200, `Worker home failed: ${homeBody}`);
  assert.match(home.headers.get('content-type') ?? '', /text\/html/);
  assert.match(homeBody, /<html/);
  console.log('Cloudflare Worker health and home smoke checks passed.');
} finally {
  await worker.stop();
}
