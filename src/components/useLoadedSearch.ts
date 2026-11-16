import { useEffect, useRef, useState } from "react";
import type { ThreadState } from "../runtime/session_types";
import {
  searchLoadedConversations,
  type LoadedSearchResult,
} from "../runtime/loaded_search";

function sourceUnavailable(thread: ThreadState) {
  return thread.reconnecting || !!thread.historyUnavailable;
}

function captureSource(thread: ThreadState | undefined) {
  return (
    thread && {
      thread,
      key: thread.key,
      agentId: thread.agentId,
      cwd: thread.cwd,
      nativeSessionId: thread.nativeSessionId,
      unavailable: sourceUnavailable(thread),
    }
  );
}

type SearchSources = ReadonlyMap<string, ReturnType<typeof captureSource>>;

function sourcesCurrent(
  captured: SearchSources,
  keys: ReadonlySet<string>,
  states: ReadonlyMap<string, ThreadState>,
) {
  if (captured.size !== keys.size) return false;
  for (const [key, source] of captured) {
    const thread = states.get(key);
    if (!keys.has(key) || thread !== source?.thread) return false;
    if (
      source &&
      thread &&
      (source.key !== thread.key ||
        source.agentId !== thread.agentId ||
        source.cwd !== thread.cwd ||
        source.nativeSessionId !== thread.nativeSessionId ||
        source.unavailable !== sourceUnavailable(thread))
    )
      return false;
  }
  return true;
}

export function useLoadedSearch(
  keys: readonly string[],
  states: ReadonlyMap<string, ThreadState>,
  query: string,
  revision: unknown,
  enabled: boolean,
) {
  // Recency reordering and new chunks in the same sources keep the throttle.
  // A replaced or no longer readable source retires the old scope immediately.
  const keySet = new Set(keys);
  const sources = useRef<SearchSources | null>(null);
  if (!sources.current || !sourcesCurrent(sources.current, keySet, states)) {
    sources.current = new Map(
      [...keySet].map((key) => [key, captureSource(states.get(key))]),
    );
  }
  const scope = sources.current;
  const [state, setState] = useState<{
    result: LoadedSearchResult | null;
    busy: boolean;
    failed: boolean;
    scope?: SearchSources;
    query?: string;
  }>({ result: null, busy: false, failed: false });
  const current = useRef({ keys, keySet, states, scope, query, enabled });
  current.current = { keys, keySet, states, scope, query, enabled };
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    const abort = new AbortController();
    const stillCurrent = () => {
      const input = current.current;
      return (
        !abort.signal.aborted &&
        input.enabled &&
        input.query === query &&
        input.scope === scope &&
        sourcesCurrent(scope, input.keySet, input.states)
      );
    };
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
        if (!stillCurrent()) return;
        running = true;
        const input = current.current;
        setState((old) => ({ ...old, busy: true, failed: false }));
        void searchLoadedConversations(input.keys, input.states, query, {
          signal: abort.signal,
        })
          .then((result) => {
            if (stillCurrent())
              setState({
                result,
                busy: false,
                failed: false,
                scope,
                query,
              });
          })
          .catch(() => {
            if (stillCurrent())
              setState({
                result: null,
                busy: false,
                failed: true,
                scope,
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
    setState({ result: null, busy: enabled, failed: false, scope, query });
    if (enabled) schedule();
    return () => {
      refresh.current = null;
      clearTimeout(timer);
      abort.abort();
    };
  }, [scope, query, enabled]);
  // Throttle rather than debounce: continuous streaming must not starve results.
  useEffect(() => {
    refresh.current?.();
  }, [revision]);
  const { result, busy, failed } = state;
  return enabled && state.scope === scope && state.query === query
    ? { result, busy, failed }
    : { result: null, busy: enabled, failed: false };
}
