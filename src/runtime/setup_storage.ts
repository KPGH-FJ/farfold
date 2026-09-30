import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import { parseAccountRegistration } from "./account_registration";
import { parseInstallationInput } from "./installation_input";
import type {
  AgentSetupProgress,
  AgentSetupSelection,
} from "../components/AgentSetup";

export const SETUP_STORAGE_KEY = "agentSetup.v1";
export const SETUP_STORAGE_STRINGS = {
  loading: "正在恢复 Agent 准备进度…",
  loadFailed: "未能读取 Agent 准备进度，请重试。原记录没有被覆盖。",
  saveFailed: "Agent 准备进度尚未保存，请重试后再关闭。",
  retry: "重试保存",
} as const;
interface Data {
  version: 1;
  completed: string[];
  pending: Record<string, string>;
  progress: Record<string, AgentSetupProgress>;
  selections: Record<string, AgentSetupSelection>;
}
interface State extends Data {
  ready: boolean;
  saving: boolean;
  error: string | null;
}
const empty = (): Data => ({
  version: 1,
  completed: [],
  pending: {},
  progress: {},
  selections: {},
});
let state: State = { ...empty(), ready: false, saving: false, error: null };
let confirmed = new Set<string>();
let savedSelections: Record<string, AgentSetupSelection> = {};
const agentEpochs = new Map<string, number>();
let loading: Promise<void> | null = null;
let writing: Promise<void> | null = null;
let revision = 0;
let savedRevision = 0;
const listeners = new Set<() => void>();
function publish(change: Partial<State>) {
  state = { ...state, ...change };
  listeners.forEach((fn) => fn());
}
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
function parseSelection(value: unknown): AgentSetupSelection {
  if (!object(value) || !object(value.config))
    throw new Error("Invalid selection");
  const config = Object.fromEntries(
    Object.entries(value.config).filter(
      ([, v]) =>
        typeof v === "string" ||
        typeof v === "boolean" ||
        (typeof v === "number" && Number.isFinite(v)),
    ),
  );
  const service = value.service;
  if (
    service !== null &&
    (!object(service) ||
      ![service.id, service.model, service.revision].every(
        (v) => typeof v === "string" && v.length > 0,
      ))
  )
    throw new Error("Invalid service");
  return {
    config,
    service:
      service === null
        ? null
        : {
            id: service.id as string,
            model: service.model as string,
            revision: service.revision as string,
          },
  };
}
function sameSelection(
  a: AgentSetupSelection | undefined,
  b: AgentSetupSelection | undefined,
) {
  return (
    !!a &&
    !!b &&
    a.service?.id === b.service?.id &&
    a.service?.model === b.service?.model &&
    a.service?.revision === b.service?.revision &&
    Object.keys(a.config).length === Object.keys(b.config).length &&
    Object.entries(a.config).every(
      ([key, value]) =>
        Object.hasOwn(b.config, key) && Object.is(value, b.config[key]),
    )
  );
}
function parseProgress(value: unknown): AgentSetupProgress {
  if (
    !object(value) ||
    ![0, 1, 2].includes(value.step as number) ||
    !["existing", "login", "api"].includes(value.choice as string)
  )
    throw new Error("Invalid preparation");
  const result: AgentSetupProgress = {
    step: value.step as number,
    choice: value.choice as AgentSetupProgress["choice"],
  };
  if (typeof value.authMethodId === "string")
    result.authMethodId = value.authMethodId;
  const registration = parseAccountRegistration(
    value.registration,
    result.authMethodId,
  );
  if (registration) result.registration = registration;
  if (["method", "account", "api"].includes(value.accessStage as string))
    result.accessStage = value.accessStage as AgentSetupProgress["accessStage"];
  if (value.selection !== undefined)
    result.selection = parseSelection(value.selection);
  const installationInput = parseInstallationInput(value.installationInput);
  if (installationInput) result.installationInput = installationInput;
  else if (
    value.installationInput !== undefined ||
    value.installationInputInvalid === true
  )
    result.installationInputInvalid = true;
  return result;
}
function parse(value: unknown): Data {
  if (value == null) return empty();
  if (
    !object(value) ||
    value.version !== 1 ||
    !Array.isArray(value.completed) ||
    !value.completed.every((v) => typeof v === "string") ||
    !object(value.pending) ||
    !object(value.progress)
  )
    throw new Error("Unknown preparation format");
  const progress = Object.fromEntries(
    Object.entries(value.progress).map(([key, item]) => [
      key,
      parseProgress(item),
    ]),
  );
  const pending = Object.fromEntries(
    Object.entries(value.pending).map(([id, key]) => {
      if (typeof key !== "string" || !Object.hasOwn(progress, key))
        throw new Error("Missing preparation");
      return [id, key];
    }),
  );
  const completed = [...new Set(value.completed as string[])];
  const selections: Record<string, AgentSetupSelection> = {};
  if (value.selections !== undefined) {
    if (!object(value.selections))
      throw new Error("Invalid confirmed selections");
    for (const [id, choice] of Object.entries(value.selections)) {
      if (!completed.includes(id)) throw new Error("Unconfirmed selection");
      selections[id] = parseSelection(choice);
    }
  } else {
    // Older data did not distinguish a confirmed choice from editable progress.
    // Recover only an exact, completed entry; a missing or changed choice needs confirmation.
    for (const id of completed) {
      const scope = pending[id],
        entry = progress[scope];
      if (
        entry?.step !== 2 ||
        !entry.selection ||
        (entry.choice === "api") !== !!entry.selection.service
      )
        continue;
      try {
        const key: unknown = JSON.parse(scope);
        if (
          Array.isArray(key) &&
          key.length === 3 &&
          key[0] === id &&
          (key[1] === null || typeof key[1] === "string") &&
          key[2] !== null &&
          sameSelection(parseSelection(key[2]), entry.selection)
        )
          selections[id] = parseSelection(entry.selection);
      } catch {
        /* Ambiguous legacy progress is retained for explicit confirmation. */
      }
    }
  }
  return {
    version: 1,
    completed,
    pending,
    progress,
    selections,
  };
}

/** Farfold-owned choices only. A completed wizard is never an auth or model-test receipt. */
export const setupStorage = {
  snapshot: () => state,
  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => {
      listeners.delete(fn);
    };
  },
  completed: (agentId: string) => confirmed.has(agentId),
  confirmedSelection(agentId: string): AgentSetupSelection | undefined {
    const selection = confirmed.has(agentId)
      ? savedSelections[agentId]
      : undefined;
    return selection ? parseSelection(selection) : undefined;
  },
  scope(agentId: string, requested: string) {
    return !confirmed.has(agentId)
      ? (state.pending[agentId] ?? requested)
      : requested;
  },
  load(): Promise<void> {
    if (state.ready) return Promise.resolve();
    return (loading ??= invoke<unknown>("settings_get", {
      key: SETUP_STORAGE_KEY,
    })
      .then((value) => {
        const data = parse(value);
        confirmed = new Set(data.completed);
        savedSelections = structuredClone(data.selections);
        publish({ ...data, ready: true, error: null });
      })
      .catch(() => {
        publish({ error: SETUP_STORAGE_STRINGS.loadFailed });
        throw new Error(SETUP_STORAGE_STRINGS.loadFailed);
      })
      .finally(() => {
        loading = null;
      }));
  },
  remember(agentId: string, scope: string, value: AgentSetupProgress) {
    if (!state.ready) throw new Error(SETUP_STORAGE_STRINGS.loadFailed);
    const next = parseProgress(value);
    if (JSON.stringify(state.progress[scope]) === JSON.stringify(next)) return;
    revision++;
    publish({
      progress: { ...state.progress, [scope]: next },
      pending: confirmed.has(agentId)
        ? state.pending
        : { ...state.pending, [agentId]: scope },
    });
    void this.flush().catch(() => undefined);
  },
  async complete(agentId: string, selection?: AgentSetupSelection) {
    const next =
      selection === undefined ? undefined : parseSelection(selection);
    await this.load();
    const epoch = agentEpochs.get(agentId) ?? 0;
    if (
      !state.completed.includes(agentId) ||
      (next && !sameSelection(state.selections[agentId], next))
    ) {
      revision++;
      publish({
        completed: [...new Set([...state.completed, agentId])],
        selections: next
          ? { ...state.selections, [agentId]: next }
          : state.selections,
      });
    }
    await this.flush();
    const saved = this.confirmedSelection(agentId);
    return (agentEpochs.get(agentId) ?? 0) === epoch &&
      sameSelection(saved, next)
      ? saved
      : undefined;
  },
  async forget(agentId: string) {
    await this.load();
    const progress = Object.fromEntries(
      Object.entries(state.progress).filter(([key]) => {
        if (key === state.pending[agentId]) return false;
        try {
          return JSON.parse(key)[0] !== agentId;
        } catch {
          return true;
        }
      }),
    );
    const pending = { ...state.pending };
    const selections = { ...state.selections };
    delete pending[agentId];
    delete selections[agentId];
    delete savedSelections[agentId];
    agentEpochs.set(agentId, (agentEpochs.get(agentId) ?? 0) + 1);
    confirmed.delete(agentId);
    revision++;
    publish({
      completed: state.completed.filter((id) => id !== agentId),
      pending,
      progress,
      selections,
    });
    await this.flush();
  },
  async flush(): Promise<void> {
    await this.load();
    if (writing) {
      await writing;
      if (savedRevision !== revision) return this.flush();
      return;
    }
    if (savedRevision === revision) return;
    writing = (async () => {
      publish({ saving: true, error: null });
      try {
        while (savedRevision !== revision) {
          const current = revision;
          const data: Data = JSON.parse(
            JSON.stringify({
              version: 1,
              completed: state.completed,
              pending: state.pending,
              progress: state.progress,
              selections: state.selections,
            }),
          );
          const epochs = new Map(agentEpochs);
          await invoke("settings_set", { key: SETUP_STORAGE_KEY, value: data });
          confirmed = new Set(
            data.completed.filter(
              (id) =>
                state.completed.includes(id) &&
                (epochs.get(id) ?? 0) === (agentEpochs.get(id) ?? 0),
            ),
          );
          savedSelections = Object.fromEntries(
            Object.entries(data.selections).filter(([id]) => confirmed.has(id)),
          );
          savedRevision = current;
          publish({});
        }
      } catch {
        publish({ error: SETUP_STORAGE_STRINGS.saveFailed });
        throw new Error(SETUP_STORAGE_STRINGS.saveFailed);
      } finally {
        publish({ saving: false });
      }
    })();
    try {
      await writing;
    } finally {
      writing = null;
    }
  },
};
export function useSetupStorage() {
  return useSyncExternalStore(
    setupStorage.subscribe,
    setupStorage.snapshot,
    setupStorage.snapshot,
  );
}
