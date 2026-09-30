import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { threads } from "./sessions";
import { STRINGS } from "./strings";
export interface WorkSnapshot {
  cwd: string;
  enabled: Record<string, boolean>;
  locationEnabled?: boolean | null;
}
const subscribers = new Set<(value: WorkSnapshot) => void>();
// A slow initial read must not overwrite a newer saved policy notification.
let changeSequence = 0;
const changes = new Map<string, { sequence: number; value: WorkSnapshot }>();
function publish(value: WorkSnapshot): void {
  threads.updateWork(
    value.cwd,
    value.enabled,
    value.locationEnabled ?? undefined,
  );
  for (const notify of subscribers) notify(value);
}
function changed(value: WorkSnapshot): void {
  changes.set(value.cwd, { sequence: ++changeSequence, value });
  publish(value);
}
export function startWorkEvents(): () => void {
  const listener = listen<WorkSnapshot>("agent-work-changed", (event) =>
    changed(event.payload),
  );
  return () => {
    void listener.then((off) => off()).catch(() => undefined);
  };
}
export function useWorkPolicy(cwd: string | null) {
  const [state, setState] = useState<WorkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const path = useRef(cwd);
  path.current = cwd;
  const canonical = useRef<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    const readSequence = changeSequence;
    setState(null);
    setError(null);
    canonical.current = null;
    const receive = (value: WorkSnapshot) => {
      if (active && value.cwd === canonical.current) setState(value);
    };
    subscribers.add(receive);
    if (cwd)
      void invoke<WorkSnapshot>("agent_work_get", { cwd })
        .then((value) => {
          if (active) {
            canonical.current = value.cwd;
            const newer = changes.get(value.cwd);
            const current =
              newer && newer.sequence > readSequence ? newer.value : value;
            setState(current);
            publish(current);
          }
        })
        .catch(() => {
          if (active) setError(STRINGS.repair.workLoadFailed);
        });
    return () => {
      active = false;
      subscribers.delete(receive);
    };
  }, [cwd, revision]);
  const pending = useRef(false);
  const set = async (agentId: string | null, enabled: boolean) => {
    if (!cwd || pending.current) return false;
    const requested = cwd;
    pending.current = true;
    setSaving(true);
    setError(null);
    try {
      const next = await invoke<WorkSnapshot>("agent_work_set", {
        agentId,
        cwd,
        enabled,
      });
      changed(next);
      if (path.current === requested) setState(next);
      return true;
    } catch {
      if (path.current === requested) setError(STRINGS.repair.workSaveFailed);
      return false;
    } finally {
      pending.current = false;
      setSaving(false);
    }
  };
  return {
    ready: state !== null,
    error,
    saving,
    cwd: state?.cwd,
    locationEnabled: state?.locationEnabled ?? undefined,
    legacyPaused:
      state !== null && Object.values(state.enabled).some((value) => !value),
    enabled: (id: string) =>
      state !== null && (state.locationEnabled ?? state.enabled[id] ?? true),
    set,
    setLocation: (enabled: boolean) => set(null, enabled),
    retry: () => setRevision((v) => v + 1),
  };
}
