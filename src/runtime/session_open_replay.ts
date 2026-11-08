import { HistoryReplayProjection } from "./history_replay_projection";
import { OpeningBaseline, type OpeningIdentity } from "./session_open_baseline";
import { applySessionEvent } from "./session_event_projection";
import type { OpenInput } from "./session_open_input";
import { STRINGS } from "./strings";
import {
  historyProjectionFailure,
  isHistoryReadFailure,
} from "./session_recovery";
import type { OpenResult } from "./session_open_types";
import type { ThreadState } from "./session_types";
import { pushRaw } from "./session_projection";
import { isProgramStatusNotification } from "./program_status";
import { isMessageUsageNotification } from "./message_usage";

/** Delivery fallback for an already-failed read, not a second projector.
 * Actual new message bytes remain exact raw envelopes: they cannot repair or
 * append to the old body after the acknowledged historical prefix failed. */
export function applyFailedHistoryEvent(
  state: ThreadState,
  event: unknown,
  apply: (event: unknown) => void,
  emit: () => void,
): void {
  if (isProgramStatusNotification(event) || isMessageUsageNotification(event))
    return;
  const update = hasOwnUpdate(event)
    ? (event as { update: unknown }).update
    : undefined;
  if (
    update &&
    typeof update === "object" &&
    ["user_message_chunk", "agent_message_chunk", "agent_thought_chunk"].some(
      (kind) => (update as { sessionUpdate?: unknown }).sessionUpdate === kind,
    )
  ) {
    pushRaw(state, event);
    emit();
    return;
  }
  try {
    apply(event);
  } catch {
    pushRaw(state, event);
    emit();
  }
}

/** A wire discriminator, not validation of a known update subtype. Preserve
 * unknown/null/partial own update payloads before interpreting local controls. */
export function hasOwnUpdate(event: unknown): boolean {
  return (
    typeof event === "object" &&
    event !== null &&
    Object.prototype.hasOwnProperty.call(event, "update")
  );
}

export function isHistoryMarkerShape(event: unknown): boolean {
  if (!event || typeof event !== "object" || Array.isArray(event)) return false;
  const value = event as Record<string, unknown>;
  return (
    Object.keys(value).length === 2 &&
    Object.prototype.hasOwnProperty.call(value, "kind") &&
    Object.prototype.hasOwnProperty.call(value, "openToken") &&
    value.kind === "session_history_complete" &&
    typeof value.openToken === "string"
  );
}

export function isOwnerHistoryMarker(event: unknown, token: string): boolean {
  return (
    isHistoryMarkerShape(event) &&
    (event as Record<string, unknown>).openToken === token
  );
}

/** One private state consumes the original queue once and transfers on success.
 * The original command owns the identity header; Agent updates cannot infer it. */
export class SessionOpenReplay {
  readonly token: string;
  private baseline?: OpeningBaseline;
  private projection: HistoryReplayProjection;
  private identified = false;
  private lost = false;
  private delivered: (() => void) | null = null;
  private endWait?: () => void;
  private permissionChanges = 0;

  constructor(
    private input: OpenInput,
    private existing: (key: string) => ThreadState | undefined = () =>
      undefined,
    restoreQueue?: (state: ThreadState) => void,
    token = crypto.randomUUID(),
    current: () => boolean = () => true,
  ) {
    this.token = token;
    this.baseline = new OpeningBaseline(input, undefined, restoreQueue);
    this.projection = new HistoryReplayProjection(
      this.baseline.state,
      token,
      (state, event, phase) => {
        this.baseline?.observe(event, phase);
        applySessionEvent(state, event, phase === "following");
      },
      current,
    );
  }

  receiveMarker(event: unknown): boolean {
    if (!isOwnerHistoryMarker(event, this.token)) return false;
    if (!this.projection.mark(this.token)) return false;
    this.delivered?.();
    return true;
  }

  push(event: unknown): "consumed" | "discarded" {
    const header = openingIdentity(event, this.token);
    if (header) {
      const key = `${this.input.agentId}:${header.cwd}:${header.sessionId}`;
      this.baseline?.identify(header, this.existing(key));
      this.identified = true;
      this.delivered?.();
      return "consumed";
    }
    if (
      !hasOwnUpdate(event) &&
      (event as { kind?: unknown } | null)?.kind === "connectionLost"
    ) {
      this.lost = true;
      this.delivered?.();
    }
    return this.projection.push(event);
  }

  async waitForReady(resumed: boolean): Promise<void> {
    const ready = () =>
      this.lost || (this.identified && (!resumed || this.projection.complete));
    if (ready()) return;
    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        this.delivered = null;
        this.endWait = undefined;
        resolve();
      };
      const timer = setTimeout(finish, 30_000);
      this.endWait = finish;
      this.delivered = () => {
        if (ready()) finish();
      };
    });
  }

  accept(
    result: OpenResult,
    savedTitle: string | null | undefined,
    existing?: ThreadState,
  ): ThreadState {
    try {
      if (result.resumed)
        this.projection.requireReadable(this.input.agentId, result, this.lost);
      if (!this.identified || !this.baseline)
        throw new Error(STRINGS.repair.reconnectFailed);
      this.baseline.accept(result, savedTitle, existing);
      const state = this.projection.take();
      this.permissionChanges = this.baseline.acceptedPermissionChanges;
      this.baseline = undefined;
      return state;
    } catch (error) {
      if (
        result.resumed &&
        !this.lost &&
        error instanceof TypeError &&
        !isHistoryReadFailure(error)
      )
        throw historyProjectionFailure(this.input.agentId, result, error);
      throw error;
    }
  }

  /** Commit only after the caller installs this exact accepted state. Failed or
   * private history cannot advance the published permission-setter guard. */
  get acceptedPermissionChanges(): number {
    return this.permissionChanges;
  }

  get acknowledgedPrefix(): boolean {
    return this.projection.complete;
  }
  clear(): void {
    this.projection.clear();
    this.baseline = undefined;
    this.permissionChanges = 0;
    this.endWait?.();
    this.delivered = null;
  }
}

function openingIdentity(
  event: unknown,
  token: string,
): OpeningIdentity | undefined {
  if (
    !event ||
    typeof event !== "object" ||
    Array.isArray(event) ||
    hasOwnUpdate(event)
  )
    return undefined;
  const e = event as Record<string, unknown>;
  if (
    e.kind !== "sessionOpening" ||
    e.openToken !== token ||
    Object.keys(e).length !== 5
  )
    return undefined;
  const valid = (value: unknown): value is string =>
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    new TextEncoder().encode(value).length <= 4096;
  if (!valid(e.cwd) || !valid(e.sessionId) || !valid(e.connectionId))
    return undefined;
  return { cwd: e.cwd, sessionId: e.sessionId, connectionId: e.connectionId };
}
