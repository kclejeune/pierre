// Installs jsdom-backed globals for React DOM tests under bun's single-process
// runner, enabling React's act() environment while installed. Returns a
// restore function for afterAll that puts every touched global back (deleting
// ones that did not exist before).
export function installJsdomGlobals(
  globals: Record<string, unknown>
): () => void {
  const keys = [...Object.keys(globals), 'IS_REACT_ACT_ENVIRONMENT'];
  const originals = new Map<string, unknown>(
    keys.map((key) => [key, Reflect.get(globalThis, key)])
  );
  Object.assign(globalThis, globals, { IS_REACT_ACT_ENVIRONMENT: true });
  return () => {
    for (const [key, value] of originals) {
      if (value === undefined) {
        Reflect.deleteProperty(globalThis, key);
      } else {
        Object.assign(globalThis, { [key]: value });
      }
    }
  };
}
