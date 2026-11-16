import { invoke } from "@tauri-apps/api/core";
import { draftPersistence } from "./draft_storage";
import type { PendingPermission, ThreadState } from "./session_types";
import { STRINGS } from "./strings";
import { uiError } from "./ui_error";
import {
  permissionDecision,
  selectablePermissionOption,
} from "./permission_options";

export interface OpeningPermission extends PendingPermission {
  owner: Record<string, unknown>;
}
interface Ports {
  current: () => boolean;
  canSubmit: () => boolean;
  changed: () => void;
  remove: () => void;
}
interface Entry {
  request: OpeningPermission;
  ports: Ports;
  timer?: ReturnType<typeof setTimeout>;
  cancelSent?: boolean;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
export function readOpeningPermission(
  event: Record<string, unknown>,
): OpeningPermission | null {
  const owner = event.owner;
  if (
    typeof event.requestId !== "string" ||
    !event.requestId ||
    !record(owner) ||
    typeof owner.connectionId !== "string" ||
    !owner.connectionId ||
    typeof owner.sessionId !== "string" ||
    !owner.sessionId ||
    owner.requestId !== event.requestId
  )
    return null;
  const tool = record(event.toolCall) ? structuredClone(event.toolCall) : null;
  return {
    requestId: event.requestId,
    status: "pending",
    error: null,
    decision: null,
    owner: structuredClone(owner),
    toolCallId: typeof tool?.toolCallId === "string" ? tool.toolCallId : null,
    toolCallSnapshot: tool,
    requestSnapshot: structuredClone(event.request),
    title: typeof tool?.title === "string" ? tool.title : "",
    kind: typeof tool?.kind === "string" ? tool.kind : "other",
    locations: Array.isArray(tool?.locations)
      ? tool.locations.flatMap((item) =>
          record(item) && typeof item.path === "string" && item.path
            ? [
                {
                  path: item.path,
                  ...(typeof item.line === "number" ? { line: item.line } : {}),
                },
              ]
            : [],
        )
      : [],
    options: Array.isArray(event.options)
      ? event.options.flatMap((option) =>
          record(option) &&
          typeof option.optionId === "string" &&
          option.optionId
            ? [
                {
                  optionId: option.optionId,
                  name:
                    typeof option.name === "string"
                      ? option.name
                      : option.optionId,
                  kind: typeof option.kind === "string" ? option.kind : "",
                },
              ]
            : [],
        )
      : [],
  };
}

/** One request object, with its reply port moved to the established view.
 * No permission is inferred from opening or from receiving a load response. */
export class OpeningPermissions {
  private entries = new Map<string, Entry>();
  private seen = new Set<string>();
  constructor(
    private ports: (request: OpeningPermission) => Ports,
    private revision: () => number = () => 0,
  ) {}
  add(request: OpeningPermission) {
    if (this.seen.has(request.requestId)) return false;
    this.seen.add(request.requestId);
    this.entries.set(request.requestId, {
      request,
      ports: this.ports(request),
    });
    return true;
  }
  reject(request: OpeningPermission) {
    this.cancel({
      request,
      ports: {
        current: () => false,
        canSubmit: () => false,
        changed: () => {},
        remove: () => {},
      },
    });
  }
  private cancel(entry: Entry) {
    clearTimeout(entry.timer);
    entry.request.decision = null;
    if (entry.cancelSent) return;
    entry.cancelSent = true;
    // Abandonment sends only the official cancelled outcome, never an option.
    void invoke("session_permission_respond", {
      requestId: entry.request.requestId,
      requestOwner: entry.request.owner,
      sessionId: entry.request.owner.sessionId,
      optionId: null,
    }).catch(() => undefined);
  }
  abandon(request: OpeningPermission) {
    const entry = this.entries.get(request.requestId);
    if (!entry || entry.request !== request) return;
    this.cancel(entry);
    this.entries.delete(request.requestId);
  }
  expire(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.entries.delete(id);
    entry.ports.remove();
    return true;
  }
  retire() {
    for (const entry of this.entries.values()) this.cancel(entry);
    this.entries.clear();
    this.seen.clear();
  }
  decide(id: string, optionId: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    const p = entry.request,
      option = p.options.find((o) => o.optionId === optionId);
    const interrupted = draftPersistence.captureInteractionInterruption();
    if (
      !option ||
      !selectablePermissionOption(p.options, option) ||
      interrupted() ||
      !entry.ports.canSubmit() ||
      p.status !== "pending" ||
      p.decision
    )
      return;
    const decision = { ...permissionDecision(option), label: option.name };
    p.decision = decision;
    const revision = this.revision();
    p.error = null;
    entry.ports.changed();
    entry.timer = setTimeout(
      () => {
        entry.timer = undefined;
        if (
          !entry.ports.current() ||
          p.decision !== decision ||
          p.status !== "pending"
        )
          return;
        if (
          interrupted() ||
          !entry.ports.canSubmit() ||
          revision !== this.revision()
        ) {
          p.decision = null;
          entry.ports.changed();
          return;
        }
        decision.undoable = false;
        void this.submit(entry);
      },
      decision.undoable ? 5000 : 0,
    );
  }
  undo(id: string) {
    const entry = this.entries.get(id);
    if (
      !entry ||
      !entry.ports.current() ||
      !entry.request.decision?.undoable ||
      entry.request.status !== "pending"
    )
      return;
    clearTimeout(entry.timer);
    entry.timer = undefined;
    entry.request.decision = null;
    entry.ports.changed();
  }
  private async submit(entry: Entry) {
    const p = entry.request,
      optionId = p.decision?.optionId;
    if (!optionId || !entry.ports.canSubmit() || p.status !== "pending") return;
    p.status = "submitting";
    entry.ports.changed();
    let reply: { status?: string; message?: string };
    try {
      reply = await invoke("session_permission_respond", {
        requestId: p.requestId,
        requestOwner: p.owner,
        sessionId: p.owner.sessionId,
        optionId,
      });
    } catch {
      reply = { status: "uncertain" };
    }
    if (!entry.ports.current()) return;
    if (reply?.status === "submitted" || reply?.status === "expired") {
      this.entries.delete(p.requestId);
      entry.ports.remove();
    } else {
      p.status = reply?.status === "retryable" ? "pending" : "uncertain";
      p.decision = null;
      p.error = uiError(
        reply?.message,
        p.status === "pending"
          ? STRINGS.repair.interactionRetryable
          : STRINGS.repair.interactionUncertain,
      );
      entry.ports.changed();
    }
  }
  handoff(state: ThreadState, current: () => boolean, changed: () => void) {
    for (const entry of this.entries.values()) {
      const p = entry.request;
      // A fork's temporary source connection is not its independent target.
      // Retain no approval from that source in the new live conversation.
      if (
        p.owner.connectionId !== state.connectionId ||
        p.owner.sessionId !== state.nativeSessionId
      ) {
        this.cancel(entry);
        continue;
      }
      state.pendingPermissions.push(p);
      entry.ports = {
        current: () => current() && state.pendingPermissions.includes(p),
        canSubmit: () =>
          current() &&
          !state.stopping &&
          !state.stopUnconfirmed &&
          state.pendingPermissions.includes(p),
        changed: () => {
          state.pendingPermissions = [...state.pendingPermissions];
          changed();
        },
        remove: () => {
          state.pendingPermissions = state.pendingPermissions.filter(
            (item) => item !== p,
          );
          changed();
        },
      };
    }
    // Only timers/in-flight replies retain an entry beyond this transfer.
    // The ordinary view owns pending requests, expiry and further decisions.
    this.entries.clear();
    this.seen.clear();
    state.pendingPermissions = [...state.pendingPermissions];
  }
}
