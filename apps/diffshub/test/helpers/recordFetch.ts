import { mock } from 'bun:test';

// A fetch stand-in for browser-client tests: records each request's method,
// parsed JSON body, and keepalive flag, and answers with whatever `respond`
// returns for it. Returning a promise lets a test hold a reply back to
// reproduce slow or out-of-order responses.

export interface RecordedRequest {
  body: unknown;
  keepalive: boolean;
  method: string;
}

export function recordFetch(
  respond: (request: RecordedRequest) => Response | Promise<Response>
): RecordedRequest[] {
  const requests: RecordedRequest[] = [];
  globalThis.fetch = mock((_input: unknown, init?: RequestInit) => {
    const request: RecordedRequest = {
      body:
        typeof init?.body === 'string'
          ? (JSON.parse(init.body) as unknown)
          : null,
      keepalive: init?.keepalive === true,
      method: init?.method ?? 'GET',
    };
    requests.push(request);
    return Promise.resolve(respond(request));
  }) as unknown as typeof fetch;
  return requests;
}

// Lets pending fetch promise chains (several awaits deep) settle.
export async function settle(): Promise<void> {
  for (let index = 0; index < 5; index++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
