import { useSyncExternalStore } from "react";
import { AuthActivity } from "./auth_activity";
// Only explicit protocol authentication errors establish a requirement. Never infer from methods.
let required: ReadonlySet<string> = new Set();
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
) {
  const id = key(agent, cwd, source);
  const needsAuth = String(error).replace(/^Error:\s*/, "") === "AUTH_REQUIRED";
  if (error !== undefined && !needsAuth) return;
  if (required.has(id) === needsAuth) return;
  const next = new Set(required);
  if (needsAuth) next.add(id);
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
  state: ReadonlySet<string>,
  agent: string,
  cwd: string | null,
  source?: string,
) {
  return cwd
    ? state.has(key(agent, cwd, source))
    : [...state].some(
        (v) => v.startsWith(`${agent}\n`) && v.endsWith(`\n${source ?? ""}`),
      );
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
