// Minimal fake window for libs that read window.localStorage directly, so
// storage round-trips and event dispatch can be observed without jsdom.
// Callers swap it into globalThis.window around each test.
export function createFakeWindow() {
  const store = new Map<string, string>();
  const sessionStore = new Map<string, string>();
  const events: Event[] = [];
  const storageFor = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  });
  return {
    events,
    store,
    window: {
      dispatchEvent(event: Event) {
        events.push(event);
        return true;
      },
      localStorage: storageFor(store),
      sessionStorage: storageFor(sessionStore),
    } as unknown as Window & typeof globalThis,
  };
}
