import type { ThreadState } from "./session_types";

/** A reviewed application supplement, never an initialize declaration. */
export interface IdentityReadSupport {
  provenance: "reviewed-official-supplement";
}
export interface SessionIdentity {
  email: string | null;
  displayName: string | null;
  workspaceName: string | null;
  organizationName: string | null;
}
export type IdentityReadError =
  | "unavailable"
  | "changed"
  | "busy"
  | "timeout"
  | "invalidResponse"
  | "queryFailed";
export type SessionIdentityRead =
  | { phase: "loading" }
  | { phase: "reported"; identity: SessionIdentity | null }
  | { phase: "error"; code: IdentityReadError };

export function identityReadSupport(
  value: unknown,
): IdentityReadSupport | null {
  return value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    (value as IdentityReadSupport).provenance === "reviewed-official-supplement"
    ? { provenance: "reviewed-official-supplement" }
    : null;
}

/** Clearing the same slot also retires its pending reply, including A→B→A. */
export function forgetSessionIdentity(s: ThreadState): void {
  delete s.sessionIdentityRead;
}
