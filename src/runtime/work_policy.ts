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
  const [revision, setRevision] = useState(0);
  type Owner = { requestedCwd: string | null; revision: number };
  const owner = useRef<Owner>({ requestedCwd: cwd, revision });
  if (owner.current.requestedCwd !== cwd || owner.current.revision !== revision)
    owner.current = { requestedCwd: cwd, revision };
  const currentOwner = owner.current;
  const [snapshot, setSnapshot] = useState<{
    owner: Owner;
    value: WorkSnapshot;
  } | null>(null);
  const [failure, setFailure] = useState<{
    owner: Owner;
    message: string;
  } | null>(null);
  const [savingFor, setSavingFor] = useState<Owner | null>(null);
  const canonical = useRef<{ owner: Owner; cwd: string } | null>(null);
  useEffect(() => {
    let active = true;
    const current = () => active && owner.current === currentOwner;
    const readSequence = changeSequence;
    setSnapshot(null);
    setFailure(null);
    canonical.current = null;
    const receive = (value: WorkSnapshot) => {
      if (
        current() &&
        canonical.current?.owner === currentOwner &&
        value.cwd === canonical.current.cwd
      )
        setSnapshot({ owner: currentOwner, value });
    };
    subscribers.add(receive);
    if (cwd)
      void invoke<WorkSnapshot>("agent_work_get", { cwd })
        .then((value) => {
          if (!current()) return;
          canonical.current = { owner: currentOwner, cwd: value.cwd };
          const newer = changes.get(value.cwd);
          const latest =
            newer && newer.sequence > readSequence ? newer.value : value;
          setSnapshot({ owner: currentOwner, value: latest });
          publish(latest);
        })
        .catch(() => {
          if (current())
            setFailure({
              owner: currentOwner,
              message: STRINGS.repair.workLoadFailed,
            });
        });
    return () => {
      active = false;
      subscribers.delete(receive);
    };
  }, [currentOwner]);
  const pending = useRef<Owner | null>(null);
  const set = async (agentId: string | null, enabled: boolean) => {
    if (!cwd || pending.current || owner.current !== currentOwner) return false;
    pending.current = currentOwner;
    setSavingFor(currentOwner);
    setFailure(null);
    try {
      const next = await invoke<WorkSnapshot>("agent_work_set", {
        agentId,
        cwd,
        enabled,
      });
      // A saved rule still updates its real location, even after navigation.
      changed(next);
      if (owner.current === currentOwner) {
        canonical.current = { owner: currentOwner, cwd: next.cwd };
        setSnapshot({ owner: currentOwner, value: next });
      }
      return true;
    } catch {
      if (owner.current === currentOwner)
        setFailure({
          owner: currentOwner,
          message: STRINGS.repair.workSaveFailed,
        });
      return false;
    } finally {
      pending.current = null;
      setSavingFor((value) => (value === currentOwner ? null : value));
    }
  };
  // React effects run after render. A new input must never expose the old
  // location's canonical path or sending policy during that first render.
  const state = snapshot?.owner === currentOwner ? snapshot.value : null;
  return {
    ready: state !== null,
    error: failure?.owner === currentOwner ? failure.message : null,
    saving: savingFor === currentOwner,
    cwd: state?.cwd,
    locationEnabled: state?.locationEnabled ?? undefined,
    legacyPaused:
      state !== null && Object.values(state.enabled).some((value) => !value),
    enabled: (id: string) =>
      owner.current === currentOwner &&
      state !== null &&
      (state.locationEnabled ?? state.enabled[id] ?? true),
    set,
    setLocation: (enabled: boolean) => set(null, enabled),
    retry: () => {
      if (owner.current === currentOwner) setRevision((v) => v + 1);
    },
  };
}
