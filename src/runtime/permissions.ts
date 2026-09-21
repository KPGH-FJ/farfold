import { invoke } from "@tauri-apps/api/core";
import type { ThreadState } from "./session_types";
import { STRINGS } from "./strings";
/** All delayed decisions belong to a particular request and decision object. */
export class PermissionActions {
  constructor(
    private get: (key: string) => ThreadState | undefined,
    private emit: () => void,
  ) {}
  decide(
    key: string,
    requestId: string,
    optionId: string,
    label: string,
    allow: boolean,
    remember = false,
  ): void {
    const s = this.get(key);
    const p = s?.pendingPermissions.find((p) => p.requestId === requestId);
    if (
      !s ||
      !p ||
      p.decision ||
      !p.options.some((o) => o.optionId === optionId)
    )
      return;
    const decision = { optionId, label, allow, undoable: remember };
    p.decision = decision;
    p.error = null;
    s.pendingPermissions = [...s.pendingPermissions];
    this.emit();
    setTimeout(
      () => {
        void this.flush(key, requestId, decision);
      },
      remember ? 5000 : 0,
    );
  }
  undo(key: string, requestId: string): void {
    const s = this.get(key);
    const p = s?.pendingPermissions.find((p) => p.requestId === requestId);
    if (!p?.decision?.undoable || p.submitting) return;
    p.decision = null;
    if (s) s.pendingPermissions = [...s.pendingPermissions];
    this.emit();
  }
  private async flush(
    key: string,
    requestId: string,
    decision: NonNullable<
      ThreadState["pendingPermissions"][number]["decision"]
    >,
  ): Promise<void> {
    const s = this.get(key);
    const p = s?.pendingPermissions.find((p) => p.requestId === requestId);
    if (!s || !p || p.decision !== decision || p.submitting) return;
    p.submitting = true;
    decision.undoable = false;
    s.pendingPermissions = [...s.pendingPermissions];
    this.emit();
    try {
      await invoke("session_permission_respond", {
        requestId,
        optionId: decision.optionId,
        sessionId: s.nativeSessionId,
      });
      if (this.get(key) !== s || !s.pendingPermissions.includes(p)) return;
      s.pendingPermissions = s.pendingPermissions.filter((item) => item !== p);
      s.items.push({
        kind: "decision",
        id: `decision-${requestId}`,
        label: decision.label,
        allow: decision.allow,
        time: Date.now(),
      });
    } catch {
      if (this.get(key) === s && s.pendingPermissions.includes(p)) {
        p.decision = null;
        p.error = STRINGS.repair.approvalFailed;
        s.pendingPermissions = [...s.pendingPermissions];
      }
    } finally {
      p.submitting = false;
      this.emit();
    }
  }
}
