import { replyToElicitation } from "./elicitation";
import { invoke } from "@tauri-apps/api/core";
import type {
  PendingElicitation,
  PendingPermission,
  ThreadState,
} from "./session_types";
import {
  expirePendingRequest,
  removePendingRequest,
} from "./session_projection";
import { STRINGS } from "./strings";
import { uiError } from "./ui_error";
import { selectablePermissionOption } from "./permission_options";

interface InteractionReply {
  status: "submitted" | "retryable" | "expired" | "uncertain";
  message?: string;
}
type PendingInteraction = PendingPermission | PendingElicitation;

/** Pending decisions and replies belong to a specific in-memory request. */
export class InteractionActions {
  constructor(
    private get: (key: string) => ThreadState | undefined,
    private emit: (key: string) => void,
  ) {}

  private publish(s: ThreadState): void {
    s.pendingPermissions = [...s.pendingPermissions];
    s.pendingElicitations = [...s.pendingElicitations];
    this.emit(s.key);
  }

  private current(s: ThreadState, request: PendingInteraction): boolean {
    return (
      this.get(s.key) === s &&
      (s.pendingPermissions.some((p) => p === request) ||
        s.pendingElicitations.some((p) => p === request))
    );
  }

  private async submit(
    s: ThreadState,
    request: PendingInteraction,
    command: string,
    args: Record<string, unknown>,
    onSubmitted?: () => void,
  ): Promise<void> {
    if (s.stopping || !this.current(s, request) || request.status !== "pending")
      return;
    request.status = "submitting";
    request.error = null;
    this.publish(s);
    let reply: InteractionReply | undefined;
    try {
      reply = await invoke<InteractionReply>(command, {
        ...args,
        sessionId: s.nativeSessionId,
        requestId: request.requestId,
      });
    } catch {
      // IPC failure can follow delivery. Retain the request but never repeat it.
      reply = { status: "uncertain" };
    }
    if (!this.current(s, request)) return;
    if (reply?.status === "submitted") {
      removePendingRequest(s, request.requestId);
      onSubmitted?.();
    } else if (reply?.status === "expired") {
      expirePendingRequest(s, request.requestId);
    } else {
      request.status = reply?.status === "retryable" ? "pending" : "uncertain";
      request.error = uiError(
        reply?.message,
        request.status === "pending"
          ? STRINGS.repair.interactionRetryable
          : STRINGS.repair.interactionUncertain,
      );
      if ("decision" in request) request.decision = null;
    }
    this.publish(s);
  }

  decide(
    key: string,
    requestId: string,
    optionId: string,
    label: string,
    allow: boolean | null,
    remember = false,
  ): void {
    const s = this.get(key);
    const p = s?.pendingPermissions.find((p) => p.requestId === requestId);
    if (
      !s ||
      s.stopping ||
      !p ||
      p.status !== "pending" ||
      p.decision ||
      !p.options.some(
        (o) =>
          o.optionId === optionId && selectablePermissionOption(p.options, o),
      )
    )
      return;
    const decision = { optionId, label, allow, undoable: remember };
    p.decision = decision;
    p.error = null;
    this.publish(s);
    setTimeout(
      () => {
        if (
          !this.current(s, p) ||
          p.decision !== decision ||
          p.status !== "pending"
        )
          return;
        if (s.stopping) {
          // A queued local choice must not become a new reply during stop.
          // Keep the same request so a later explicit decision remains possible.
          p.decision = null;
          this.publish(s);
          return;
        }
        decision.undoable = false;
        void this.submit(
          s,
          p,
          "session_permission_respond",
          { optionId },
          () => {
            s.items.push({
              kind: "decision",
              id: `decision-${requestId}`,
              label,
              allow,
              time: Date.now(),
            });
          },
        );
      },
      remember ? 5000 : 0,
    );
  }

  undo(key: string, requestId: string): void {
    const s = this.get(key);
    const p = s?.pendingPermissions.find((p) => p.requestId === requestId);
    if (!p?.decision?.undoable || p.status !== "pending") return;
    p.decision = null;
    if (s) this.publish(s);
  }

  async respondElicitation(
    key: string,
    requestId: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ): Promise<void> {
    const s = this.get(key);
    const p = s?.pendingElicitations.find((p) => p.requestId === requestId);
    if (!s || !p) return;
    await replyToElicitation(p, action, values, {
      sessionId: s.nativeSessionId,
      current: () =>
        !s.stopping &&
        (!s.stopUnconfirmed || action !== "accept") &&
        this.current(s, p),
      changed: () => this.publish(s),
      remove: (notice) => {
        if (notice) expirePendingRequest(s, p.requestId);
        else removePendingRequest(s, p.requestId);
        this.publish(s);
      },
    });
  }
}
