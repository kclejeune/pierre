// Captures what the logging modules write, since their whole contract is the
// exact JSON line and the stream it lands on (stderr for failures so container
// log tooling can filter them). console is restored even if `run` throws, and a
// rejection is swallowed: tests that care about a rethrow assert it separately.

export interface CapturedLine {
  line: string;
  stream: 'stderr' | 'stdout';
}

export async function captureConsole(
  run: () => unknown
): Promise<CapturedLine[]> {
  const captured: CapturedLine[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (value: unknown) => {
    captured.push({ line: String(value), stream: 'stdout' });
  };
  console.error = (value: unknown) => {
    captured.push({ line: String(value), stream: 'stderr' });
  };
  try {
    await run();
  } catch {
    // Recorded by the caller's own assertion, not this helper's concern.
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return captured;
}

export async function captureLogRecords(
  run: () => unknown
): Promise<Record<string, unknown>[]> {
  const captured = await captureConsole(run);
  return captured.map(
    ({ line }) => JSON.parse(line) as Record<string, unknown>
  );
}
