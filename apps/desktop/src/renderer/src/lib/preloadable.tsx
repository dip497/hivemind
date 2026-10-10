import { lazy, useState, type ComponentType } from "react";

/** `lazy` whose code can be fetched ahead of time, and which renders at once when it has been.
 *  A plain `lazy` suspends on its first render however long ago its code arrived, and React then
 *  holds the fallback for its 300 ms reveal throttle. */
export function preloadable<P extends object>(load: () => Promise<ComponentType<P>>) {
  let loaded: ComponentType<P> | undefined;
  let pending: Promise<ComponentType<P>> | undefined;
  const preload = () => (pending ??= load().then(
    (c) => (loaded = c),
    (e: unknown) => { pending = undefined; throw e; },
  ));
  const Lazy = lazy(() => preload().then((c) => ({ default: c })));
  function Preloadable(props: P) {
    // Fixed for the mount: switching from Lazy to the loaded component would remount it.
    const [C] = useState<ComponentType<P>>(() => loaded ?? Lazy);
    return <C {...props} />;
  }
  return Object.assign(Preloadable, { preload });
}
