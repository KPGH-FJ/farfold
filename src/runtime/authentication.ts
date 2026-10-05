import { useSyncExternalStore } from "react";
import { AuthActivity } from "./auth_activity";
// Only explicit protocol authentication errors establish a requirement. Never infer from methods.
type AuthenticationStage = "session" | "request";
let required: ReadonlyMap<string, AuthenticationStage> = new Map();
const listeners = new Set<() => void>();
const accountListeners = new Set<(agentId: string) => void>();
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
