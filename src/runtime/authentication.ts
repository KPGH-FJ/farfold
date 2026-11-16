import { useSyncExternalStore } from "react";
import { AuthActivity } from "./auth_activity";
import { authActive } from "./auth_activity";
// Only explicit protocol authentication errors establish a requirement. Never infer from methods.
type AuthenticationStage = "session" | "request";
let required: ReadonlyMap<string, AuthenticationStage> = new Map();
const listeners = new Set<() => void>();
const accountListeners = new Set<(agentId: string) => void>();
const programObservers = new Map<string, AuthenticationObserver>();
const programChanges = new Map<string, Set<Promise<void>>>();

export function beginProgramAuthenticationChange(agent: string) {
  const changes = programChanges.get(agent) ?? new Set();
  programChanges.set(agent, changes);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => (release = resolve));
  changes.add(pending);
  return () => {
    changes.delete(pending);
    if (changes.size === 0 && programChanges.get(agent) === changes)
      programChanges.delete(agent);
    release();
  };
}

export function hasPendingProgramAuthenticationChange(agent: string) {
  return programChanges.has(agent);
}

export function pendingProgramAuthenticationChange(
  agent: string,
): Promise<void> | undefined {
  const changes = programChanges.get(agent);
  return changes
    ? Promise.all(changes).then(() => pendingProgramAuthenticationChange(agent))
    : undefined;
}
/** Explicit account/configuration actions invalidate prior model verification. */
export function invalidateAuthentication(agentId: string) {
  for (const listener of accountListeners) listener(agentId);
}
export function subscribeAuthenticationChanges(
  listener: (agentId: string) => void,
) {
  accountListeners.add(listener);
  return () => {
    accountListeners.delete(listener);
  };
}
const key = (agent: string, cwd: string, source?: string) =>
  `${agent}\n${cwd}\n${source ?? ""}`;
export function observeAuthentication(
  agent: string,
  cwd: string,
  error?: unknown,
  source?: string,
  stage: AuthenticationStage = "session",
) {
  const id = key(agent, cwd, source);
  const needsAuth = String(error).replace(/^Error:\s*/, "") === "AUTH_REQUIRED";
  if (error !== undefined && !needsAuth) return;
  const previous = required.get(id);
  // Some Agents expose models before checking credentials at the first prompt.
  // A successful session open cannot disprove that stronger request failure.
  if (previous === "request" && stage === "session") return;
  if (needsAuth ? previous === stage : !previous) return;
  const next = new Map(required);
  if (needsAuth) next.set(id, stage);
  else next.delete(id);
  required = next;
  listeners.forEach((fn) => fn());
}

type AuthenticationObserver = {
  current: () => boolean;
  observe: (
    cwd: string,
    error?: unknown,
    source?: string,
    stage?: AuthenticationStage,
  ) => void;
};

/** Older openings and deliveries cannot publish evidence for a new program. */
export function captureProgramAuthentication(
  agent: string,
): AuthenticationObserver {
  const existing = programObservers.get(agent);
  if (existing) return existing;
  const current = () => programObservers.get(agent) === observer;
  const observer: AuthenticationObserver = {
    current,
    observe: (cwd, error, source, stage) => {
      if (current()) observeAuthentication(agent, cwd, error, source, stage);
    },
  };
  programObservers.set(agent, observer);
  return observer;
}

const threadObservers = new WeakMap<object, AuthenticationObserver>();
export function bindProgramAuthentication(
  thread: object,
  observer: AuthenticationObserver | undefined,
) {
  if (observer) threadObservers.set(thread, observer);
}
export function threadProgramAuthentication(thread: object) {
  return threadObservers.get(thread);
}

/** A committed replacement invalidates only evidence collected by its old program. */
export function programAuthenticationChanged(agent: string) {
  programObservers.delete(agent);
  const next = new Map(required);
  for (const id of required.keys())
    if (id.startsWith(`${agent}\n`)) next.delete(id);
  if (next.size !== required.size) {
    required = next;
    listeners.forEach((fn) => fn());
  }
  invalidateAuthentication(agent);
}

export function useAuthentication() {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => required,
    () => required,
  );
}
export function authenticationRequired(
  state: ReadonlySet<string> | ReadonlyMap<string, AuthenticationStage>,
  agent: string,
  cwd: string | null,
  source?: string,
) {
  return cwd
    ? state.has(key(agent, cwd, source))
    : [...state.keys()].some(
        (v) => v.startsWith(`${agent}\n`) && v.endsWith(`\n${source ?? ""}`),
      );
}

/** Recheck at asynchronous action boundaries, before React has to render. */
export function currentAuthenticationRequired(
  agent: string,
  cwd: string | null,
  source?: string,
) {
  return authenticationRequired(required, agent, cwd, source);
}

const activities = new Map<string, AuthActivity>();
/** Include account actions even when their settings view is no longer mounted. */
export function hasActiveAuthentication() {
  return [...activities.values()].some((activity) =>
    authActive(activity.getSnapshot()),
  );
}
export function authenticationActivity(agentId: string) {
  let activity = activities.get(agentId);
  if (!activity) {
    activity = new AuthActivity();
    activities.set(agentId, activity);
  }
  return activity;
}
export function useAuthenticationActivity(agentId: string) {
  const activity = authenticationActivity(agentId);
  return useSyncExternalStore(
    activity.subscribe,
    activity.getSnapshot,
    activity.getSnapshot,
  );
}
