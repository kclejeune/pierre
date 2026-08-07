// Minimal fake window for libs that read window.localStorage directly, so
// storage round-trips and event dispatch can be observed without jsdom.
// Callers swap it into globalThis.window around each test.
export function createFakeWindow() {
  const store = new Map<string, string>();
  const events: Event[] = [];
  return {
    events,
    store,
    window: {
      dispatchEvent(event: Event) {
        events.push(event);
        return true;
      },
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        removeItem: (key: string) => void store.delete(key),
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    } as unknown as Window & typeof globalThis,
  };
}
