import { useEffect, useRef } from 'react';
import { ApiError } from './api';

// Poll only visible tabs, never overlap requests, and back off after failures.
// A null interval loads on entry/return to the tab without idle polling.
export function useVisiblePoll(
  load: () => Promise<void>,
  intervalMs: number | null,
  onError: (error: Error) => void,
) {
  const errorHandler = useRef(onError);
  errorHandler.current = onError;
  const inFlight = useRef<{ load: () => Promise<void>; request: Promise<void> } | null>(null);
  const retryAt = useRef(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    function schedule(delay: number) {
      clearTimeout(timer);
      if (active && !document.hidden) timer = setTimeout(tick, delay);
    }
    async function tick() {
      if (!active || document.hidden) return;
      if (Date.now() < retryAt.current) {
        schedule(retryAt.current - Date.now());
        return;
      }
      let delay = intervalMs;
      try {
        // Wait for an old query before loading a changed filter; interval changes reuse it.
        if (inFlight.current && inFlight.current.load !== load) {
          await inFlight.current.request.catch(() => {});
          if (!active || document.hidden) return;
        }
        const request = inFlight.current?.load === load ? inFlight.current.request : load();
        inFlight.current = { load, request };
        await request;
        if (inFlight.current?.request === request) inFlight.current = null;
        failures = 0;
      } catch (e) {
        inFlight.current = null;
        const error = e instanceof Error ? e : new Error('Could not refresh the dashboard.');
        if (active) errorHandler.current(error);
        delay = Math.max(
          Math.min(300_000, 10_000 * 2 ** failures++),
          error instanceof ApiError ? error.retryAfterMs : 0,
        );
        retryAt.current = Date.now() + delay;
      }
      if (active && delay !== null) schedule(delay);
    }
    function visibility() {
      clearTimeout(timer);
      if (!document.hidden) void tick();
    }
    document.addEventListener('visibilitychange', visibility);
    void tick();
    return () => {
      active = false;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [load, intervalMs]);
}
