/**
 * Terminals restored with a workspace build their screens on screen first. A workspace opened with
 * many terminals built every one in the same task, off screen or not, so the window stayed blank for a second. A terminal on
 * screen builds as soon as it is laid out; one off screen waits for an idle moment, one at a time,
 * or until it comes into view. Its session runs meanwhile; only its screen here waits.
 */

/** Longest an off-screen terminal waits for an idle moment. */
const IDLE_WAIT_MS = 500;

const waiting = new Map<Element, (onScreen: boolean) => void>();
/** Hosts whose first place the observer has told: only those wait for an idle moment. */
const placed = new Set<Element>();
let idle = 0;
let io: IntersectionObserver | null = null;

function build(host: Element, onScreen: boolean): void {
  const mount = waiting.get(host);
  if (!mount) return;
  waiting.delete(host);
  placed.delete(host);
  io?.unobserve(host);
  mount(onScreen);
}

function buildNextWhenIdle(): void {
  if (idle || placed.size === 0) return;
  idle = requestIdleCallback(() => {
    idle = 0;
    const next = placed.values().next().value;
    if (next) build(next, false);
    buildNextWhenIdle();
  }, { timeout: IDLE_WAIT_MS });
}

function observer(): IntersectionObserver {
  io ??= new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) build(e.target, true);
      else if (waiting.has(e.target)) placed.add(e.target);
    }
    buildNextWhenIdle();
  });
  return io;
}

/** Calls `mount` once `host` is on screen, or at an idle moment if it is not. The returned function
 *  takes it out of the line (the tile went before it was built). `onScreen`: it was on screen. */
export function whenTerminalMayBuild(host: Element, mount: (onScreen: boolean) => void): () => void {
  // A hidden window draws nothing, so the observer would not tell where it is.
  if (typeof IntersectionObserver === "undefined" || typeof requestIdleCallback === "undefined" || document.hidden) {
    mount(true);
    return () => {};
  }
  waiting.set(host, mount);
  observer().observe(host);
  return () => {
    waiting.delete(host);
    placed.delete(host);
    io?.unobserve(host);
  };
}
