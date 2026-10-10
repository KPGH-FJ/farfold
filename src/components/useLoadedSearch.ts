import { useEffect, useRef, useState } from "react";
import type { ThreadState } from "../runtime/session_types";
import {
  searchLoadedConversations,
  type LoadedSearchResult,
} from "../runtime/loaded_search";

export function useLoadedSearch(
  keys: readonly string[],
  states: ReadonlyMap<string, ThreadState>,
  query: string,
  revision: unknown,
  enabled: boolean,
) {
  // Recency reordering during two streams does not change the searched scope.
  // Only membership/query changes cancel work; revisions schedule another scan.
  const signature = JSON.stringify([...new Set(keys)].sort());
  const [state, setState] = useState<{
    result: LoadedSearchResult | null;
    busy: boolean;
    failed: boolean;
    signature?: string;
    query?: string;
  }>({ result: null, busy: false, failed: false });
  const current = useRef({ keys, states, query, enabled, revision });
  current.current = { keys, states, query, enabled, revision };
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let running = false;
    let dirty = false;
    const schedule = () => {
      if (abort.signal.aborted) return;
      dirty = true;
      if (timer || running) return;
      timer = setTimeout(() => {
        timer = undefined;
        dirty = false;
        running = true;
        const input = current.current;
        setState((old) => ({ ...old, busy: true, failed: false }));
        void searchLoadedConversations(input.keys, input.states, query, {
          signal: abort.signal,
        })
          .then((result) => {
            if (!abort.signal.aborted)
              setState({
                result,
                busy: false,
                failed: false,
                signature,
                query,
              });
          })
          .catch(() => {
            if (!abort.signal.aborted)
              setState({
                result: null,
                busy: false,
                failed: true,
                signature,
                query,
              });
          })
          .finally(() => {
            running = false;
            if (dirty) schedule();
          });
      }, 120);
    };
    refresh.current = enabled ? schedule : null;
    setState({ result: null, busy: enabled, failed: false, signature, query });
    if (enabled) schedule();
    return () => {
      refresh.current = null;
      clearTimeout(timer);
      abort.abort();
    };
  }, [signature, query, enabled]);
  // Throttle rather than debounce: continuous streaming must not starve results.
  useEffect(() => {
    refresh.current?.();
  }, [revision]);
  return enabled && state.signature === signature && state.query === query
    ? state
    : { result: null, busy: enabled, failed: false };
}
