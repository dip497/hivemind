import { useState, useRef, useCallback } from "react";
import type { Dispatch, SetStateAction, MutableRefObject } from "react";

/**
 * useState that also exposes its latest value through a ref — the ref is
 * updated INSIDE the state updater (render phase, before commit) instead of a
 * separate post-commit `useEffect`. Collapses the `const [x, setX] = useState();
 * const xRef = useRef(x); useEffect(() => { xRef.current = x }, [x])` triple the
 * canvas repeated in seven places into one line, deleting seven sync effects.
 *
 * Safe here because these refs are read ONLY in event handlers / async callbacks
 * / effects (all post-commit) — never during render, where the `x` state value
 * is used directly. The updater stays deterministic (next derived from prev), so
 * StrictMode's double-invoke sets the same value twice (harmless).
 *
 * NOTE: like the old effect, the ref is NOT updated synchronously at the `setX`
 * call site (React runs the updater later, when it flushes). Code that needs a
 * value to be visible to a *following line in the same handler* must still write
 * the ref explicitly (e.g. `framesRef.current = next`) — those few patches stay.
 */
export function useStateWithRef<T>(
  initial: T | (() => T),
): [T, Dispatch<SetStateAction<T>>, MutableRefObject<T>] {
  const [state, setState] = useState<T>(initial);
  const ref = useRef<T>(state);
  const set = useCallback<Dispatch<SetStateAction<T>>>((value) => {
    setState((prev) => {
      const next = typeof value === "function" ? (value as (p: T) => T)(prev) : value;
      ref.current = next;
      return next;
    });
  }, []);
  return [state, set, ref];
}
