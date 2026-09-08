// Next calls register() once per server process, before any request is handled.
// Load the logger only in Node so it is not included in the Edge bundle, where
// process.env carries only values inlined by Next.
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { logStartupConfiguration } = await import('@/lib/startupLog');
    logStartupConfiguration();
  }
}
