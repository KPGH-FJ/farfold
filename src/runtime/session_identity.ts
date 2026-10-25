import { invoke } from "@tauri-apps/api/core";
import { configChangeBusy } from "./protected_config";
import type { ThreadState } from "./session_types";
import {
  forgetSessionIdentity,
  identityReadSupport,
  type IdentityReadError,
  type SessionIdentity,
  type SessionIdentityRead,
} from "./session_identity_types";

export type IdentityTarget = {
  agentId: string;
  cwd: string;
  sessionId: string;
  connectionId: string;
};
const object = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);
const nonempty = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && !v.includes("\0");
const sourceOf = (s: ThreadState) =>
  JSON.stringify([
    s.serviceContext ?? null,
    s.service?.id ?? null,
    s.service?.fingerprint ?? null,
  ]);

export function hasIdentityReadOwner(
  s: ThreadState | null | undefined,
): boolean {
  return Boolean(
    s &&
    [s.key, s.agentId, s.cwd, s.nativeSessionId, s.connectionId].every(
      nonempty,
    ) &&
    !s.connectionLost &&
    !s.reconnecting &&
    !s.openError &&
    !s.historyUnavailable &&
    !s.unrecoverable,
  );
}

/** A second whitelist at the IPC boundary; raw extras never enter view state. */
export function reportedSessionIdentity(
  value: unknown,
  target: IdentityTarget,
): { identity: SessionIdentity | null } | null {
  if (
    !object(value) ||
    value.connectionId !== target.connectionId ||
    value.nativeSessionId !== target.sessionId ||
    value.cwd !== target.cwd
  )
    return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).length > 16 * 1024)
      return null;
  } catch {
    return null;
  }
  if (value.identity === null) return { identity: null };
  const identity = value.identity;
  if (!object(identity)) return null;
  const safe: SessionIdentity = {
    email: null,
    displayName: null,
    workspaceName: null,
    organizationName: null,
  };
  for (const key of Object.keys(safe) as (keyof SessionIdentity)[]) {
    const text = identity[key];
    if (text === null) continue;
    if (
      typeof text !== "string" ||
      !text.trim() ||
      text.length > (key === "email" ? 254 : 256) ||
      /[\u0000-\u001f\u007f-\u009f]/u.test(text) ||
      (key === "email" &&
        (text.split("@").length !== 2 ||
          text.startsWith("@") ||
          text.endsWith("@") ||
          /\s/u.test(text)))
    )
      return null;
    safe[key] = text;
  }
  return { identity: safe };
}

/** One explicit read on the existing owner. The slot is never persisted. */
export async function readSessionIdentity(
  owner: ThreadState,
  current: () => ThreadState | undefined,
  emit: () => void,
  query: (args: IdentityTarget) => Promise<unknown> = (args) =>
    invoke("session_identity_read", args),
): Promise<boolean> {
  if (
    current() !== owner ||
    !hasIdentityReadOwner(owner) ||
    !identityReadSupport(owner.identityRead) ||
    configChangeBusy(owner) ||
    owner.sessionIdentityRead?.phase === "loading"
  )
    return false;
  const target: IdentityTarget = {
    agentId: owner.agentId,
    cwd: owner.cwd,
    sessionId: owner.nativeSessionId,
    connectionId: owner.connectionId!,
  };
  const key = owner.key;
  const source = sourceOf(owner);
  const slot: SessionIdentityRead = { phase: "loading" };
  owner.sessionIdentityRead = slot;
  const owns = () =>
    current() === owner &&
    owner.sessionIdentityRead === slot &&
    hasIdentityReadOwner(owner) &&
    identityReadSupport(owner.identityRead) &&
    owner.key === key &&
    owner.agentId === target.agentId &&
    owner.cwd === target.cwd &&
    owner.nativeSessionId === target.sessionId &&
    owner.connectionId === target.connectionId &&
    sourceOf(owner) === source;
  emit();
  try {
    const value = await query(target);
    if (!owns()) return false;
    if (configChangeBusy(owner)) {
      owner.sessionIdentityRead = { phase: "error", code: "busy" };
      return false;
    }
    const result = reportedSessionIdentity(value, target);
    owner.sessionIdentityRead = result
      ? { phase: "reported", identity: result.identity }
      : { phase: "error", code: "invalidResponse" };
    return result !== null;
  } catch (error) {
    if (!owns()) return false;
    const codes: IdentityReadError[] = [
      "unavailable",
      "changed",
      "busy",
      "timeout",
      "invalidResponse",
      "queryFailed",
    ];
    const code =
      object(error) && codes.includes(error.code as IdentityReadError)
        ? (error.code as IdentityReadError)
        : "queryFailed";
    if (
      code === "unavailable" &&
      object(error) &&
      typeof error.message === "string"
    )
      owner.identityRead = null;
    owner.sessionIdentityRead = { phase: "error", code };
    return false;
  } finally {
    // A retired request cannot erase a newer read or update another owner.
    if (owner.sessionIdentityRead === slot) forgetSessionIdentity(owner);
    if (current() === owner) emit();
  }
}
