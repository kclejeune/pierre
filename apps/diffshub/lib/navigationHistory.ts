// Back/forward history for in-viewer jumps (go to definition), modeled on an
// editor's navigation stack rather than the browser's: each jump records the
// location it left, Back returns there, and Forward replays the jump. A new
// jump after going back discards the forward entries, as in browsers.
//
// `current` is where the last jump landed. It can be null when a jump ended
// on a list (several definition candidates) instead of a single location;
// Back still returns to the origin, there is just nothing to go forward to.

const MAX_NAVIGATION_HISTORY = 50;

export class NavigationHistory<T> {
  private back: T[] = [];
  private forward: T[] = [];
  private current: T | null = null;

  constructor(private limit = MAX_NAVIGATION_HISTORY) {}

  get canGoForward(): boolean {
    return this.forward.length > 0;
  }

  // Records a jump from `from` to `to` (null when it landed on a list).
  push(from: T, to: T | null): void {
    this.back.push(from);
    if (this.back.length > this.limit) {
      this.back.shift();
    }
    this.forward = [];
    this.current = to;
  }

  goBack(): T | null {
    const target = this.back.pop();
    if (target == null) {
      return null;
    }
    if (this.current != null) {
      this.forward.push(this.current);
    }
    this.current = target;
    return target;
  }

  goForward(): T | null {
    const target = this.forward.pop();
    if (target == null) {
      return null;
    }
    if (this.current != null) {
      this.back.push(this.current);
    }
    this.current = target;
    return target;
  }
}
