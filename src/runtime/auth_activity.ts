import type { PendingElicitation } from "./session_types";
import { readElicitation, replyToElicitation } from "./elicitation";
import { INQUIRY } from "./elicitation_strings";
import { BufferedLoginTerminal } from "./login_terminal";
import { AUTH_ACTIVITY_STRINGS } from "./auth_strings";
import { PREPARATION_ACTION_STRINGS as P } from "./preparation_action_strings";

export type AuthOperation =
  | {
      kind: "authentication";
      methodId: string;
      title: string;
      completion: "exit_code" | "return_and_verify";
      intent?: "login" | "logout" | "switch_account";
    }
  | {
      kind: "preparation";
      actionId: string;
      purpose: "service_configuration";
      title: string;
      completion: "exit_code";
    };

export interface AuthTarget {
  agentId: string;
  cwd: string;
  source?: string;
}
export type AuthPhase =
  | "starting"
  | "waiting"
  | "unknown"
  | "cancelling"
  | "checking"
  | "completed"
  | "cancelled"
  | "failed";
export interface AuthActivitySnapshot {
  inquiries?: PendingElicitation[];
  inquiryNotice?: string;
  inquiryDetail?: unknown;
  attemptId: string;
  target: AuthTarget;
  operation: Readonly<AuthOperation>;
  phase: AuthPhase;
  error: unknown;
  terminal: BufferedLoginTerminal | null;
  terminalOutcome:
    | { kind: "ended"; code: number; cancelled: boolean }
    | { kind: "cancelled" }
    | { kind: "failed"; error: unknown }
    | null;
  /** A successful flow response, distinct from a later connection recheck. */
  operationConfirmed: boolean;
  checked: boolean;
  /** The user chose to end this terminal and check, retained across close retries. */
  finishRequested: boolean;
}
export const authActive = (value: AuthActivitySnapshot | null) =>
  !!value && !["completed", "cancelled", "failed"].includes(value.phase);

/** One user-authored account action. It outlives all views, but never the app. */
export class AuthActivity {
  private value: AuthActivitySnapshot | null = null;
  private listeners = new Set<() => void>();
  private cancelOperation: (() => Promise<void>) | null = null;
  private endOperation: (() => Promise<void>) | null = null;
  private finishIntent = false;
  private startCancelled = false;
  readonly subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  readonly getSnapshot = () => this.value;
  canStart(attemptId: string) {
    return this.value?.attemptId === attemptId && !this.startCancelled;
  }
  private update(patch: Partial<AuthActivitySnapshot>) {
    if (!this.value) return;
    this.value = { ...this.value, ...patch };
    this.listeners.forEach((listener) => listener());
  }
  begin(target: AuthTarget, operation: AuthOperation, attemptId: string) {
    if (authActive(this.value))
      throw new Error(AUTH_ACTIVITY_STRINGS.busyOther);
    if (target.source) throw new Error(AUTH_ACTIVITY_STRINGS.apiSource);
    this.value = {
      target: { ...target },
      operation: Object.freeze({ ...operation }),
      attemptId,
      phase: "starting",
      error: null,
      terminal: null,
      terminalOutcome: null,
      operationConfirmed: false,
      checked: false,
      finishRequested: false,
    };
    this.finishIntent = false;
    this.startCancelled = false;
    this.cancelOperation = null;
    this.endOperation = null;
    this.listeners.forEach((listener) => listener());
  }
  inquiryEvent(attemptId: string, raw: unknown) {
    if (
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw) ||
      this.value?.attemptId !== attemptId ||
      !authActive(this.value)
    )
      return;
    const event = raw as Record<string, unknown>;
    const inquiries = this.value.inquiries ?? [];
    if (
      event.kind === "elicitation" &&
      !this.startCancelled &&
      !["cancelling", "checking"].includes(this.value.phase)
    ) {
      const request = readElicitation(event);
      if (request && !inquiries.some((p) => p.requestId === request.requestId))
        this.update({ inquiries: [...inquiries, request] });
    } else if (
      event.kind === "elicitationComplete" ||
      event.kind === "interactionExpired"
    ) {
      if (!inquiries.some((p) => p.requestId === event.requestId)) return;
      this.update({
        inquiries: inquiries.filter((p) => p.requestId !== event.requestId),
        inquiryNotice:
          event.kind === "elicitationComplete"
            ? INQUIRY.complete
            : INQUIRY.expired,
      });
    } else if (event.kind === "elicitationUnavailable")
      this.update({
        inquiryNotice: INQUIRY.unavailable,
        inquiryDetail: event.params,
      });
  }
  editInquiry(requestId: string, name: string, value: unknown) {
    const request = this.value?.inquiries?.find(
      (p) => p.requestId === requestId,
    );
    if (
      !request ||
      request.status !== "pending" ||
      !this.value ||
      !this.canStart(this.value.attemptId) ||
      !authActive(this.value) ||
      ["checking", "cancelling"].includes(this.value.phase)
    )
      return;
    request.values = { ...request.values, [name]: value };
    this.update({ inquiries: [...this.value!.inquiries!] });
  }
  async replyInquiry(
    requestId: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ) {
    const job = this.value;
    const request = job?.inquiries?.find((p) => p.requestId === requestId);
    if (!job || !request) return;
    await replyToElicitation(request, action, values, {
      current: () =>
        this.canStart(job.attemptId) &&
        this.value?.attemptId === job.attemptId &&
        authActive(this.value) &&
        !["cancelling", "checking"].includes(this.value.phase) &&
        !!this.value.inquiries?.includes(request),
      changed: () =>
        this.update({ inquiries: [...(this.value?.inquiries ?? [])] }),
      remove: (notice) =>
        this.update({
          inquiries: this.value?.inquiries?.filter((p) => p !== request),
          ...(notice ? { inquiryNotice: notice } : {}),
        }),
    });
  }
  async protocol(ports: {
    run: (unknown: () => void) => Promise<unknown>;
    cancel: () => Promise<void>;
    end?: () => Promise<void>;
    reconnect: () => Promise<void>;
  }) {
    const id = this.value?.attemptId;
    this.cancelOperation = ports.cancel;
    this.endOperation = ports.end ?? null;
    this.update({ phase: "waiting" });
    try {
      await ports.run(() => {
        if (
          this.value?.attemptId === id &&
          authActive(this.value) &&
          this.value?.phase !== "checking"
        )
          this.update({ phase: "unknown" });
      });
      if (this.value?.attemptId !== id) return;
      this.update({ operationConfirmed: true });
      // A late successful response after cancellation is still a real success,
      // never labelled as cancelled or as proven model availability.
      await this.check(ports.reconnect);
    } catch (error) {
      if (this.value?.attemptId === id)
        this.update({
          phase:
            String(error).replace(/^Error:\s*/, "") === "AUTH_CANCELLED"
              ? "cancelled"
              : "failed",
          error,
        });
    }
  }
  terminal(ports: {
    start: (output: (data: string) => void) => Promise<string>;
    wait: (id: string) => Promise<number>;
    close: (id: string) => Promise<number | null>;
    reconnect: () => Promise<void>;
    cancel?: () => Promise<void>;
  }) {
    const id = this.value?.attemptId;
    const terminal = new BufferedLoginTerminal({
      ...ports,
      error: (error) => {
        if (
          this.value?.attemptId === id &&
          authActive(this.value) &&
          this.value?.phase !== "checking"
        )
          this.update({ phase: "unknown", error });
      },
      exit: (code, cancelled) => {
        if (this.value?.attemptId !== id) return;
        this.update({
          terminalOutcome: { kind: "ended", code, cancelled },
          operationConfirmed: code === 0,
        });
        if (this.finishIntent || code === 0) void this.check(ports.reconnect);
        else
          this.update({
            phase: cancelled ? "cancelled" : "failed",
            error: cancelled
              ? null
              : this.value?.operation.kind === "preparation"
                ? P.exitFailed(code)
                : AUTH_ACTIVITY_STRINGS.loginIncomplete(code),
          });
      },
    });
    this.cancelOperation = async () => {
      // Register cancellation before a PTY id exists. Still reap an id whose
      // startup response arrives late; neither an IPC reply nor view teardown
      // proves that the terminal has ended.
      const results = await Promise.allSettled([
        ports.cancel?.() ?? Promise.resolve(),
        terminal.close(),
      ]);
      const failed = results.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
    };
    this.update({ terminal, phase: "starting" });
    void terminal.start().then(
      () => {
        // Readiness must notify the account view, but cannot undo a cancellation,
        // unknown wait result, or an exit that overtook the startup response.
        if (this.value?.attemptId === id && this.value?.phase === "starting")
          this.update({ phase: "waiting" });
      },
      (error) => {
        if (this.value?.attemptId === id) {
          const cancelled =
            String(error).replace(/^Error:\s*/, "") === "AUTH_CANCELLED";
          this.update({
            phase: cancelled ? "cancelled" : "failed",
            error: cancelled ? null : error,
            terminalOutcome: cancelled
              ? { kind: "cancelled" }
              : { kind: "failed", error },
          });
        }
      },
    );
  }
  private async check(reconnect: () => Promise<void>) {
    this.update({ phase: "checking" });
    try {
      await reconnect();
      this.update({ phase: "completed", checked: true, error: null });
    } catch (error) {
      this.update({ phase: "completed", checked: false, error });
    }
  }
  async cancel(verify = false) {
    if (!authActive(this.value) || this.value?.phase === "checking") return;
    const id = this.value?.attemptId;
    this.startCancelled = true;
    this.finishIntent ||= verify;
    this.update({
      phase: "cancelling",
      error: null,
      finishRequested: this.finishIntent,
    });
    try {
      await this.cancelOperation?.();
    } catch (error) {
      const current = this.getSnapshot();
      if (
        current?.attemptId === id &&
        authActive(current) &&
        current?.phase !== "checking"
      )
        this.update({ phase: "unknown", error });
    }
  }
  async finishTerminal() {
    const current = this.value;
    const terminal = current?.terminal?.getSnapshot();
    if (
      !authActive(current) ||
      current?.phase === "checking" ||
      current?.phase === "cancelling" ||
      !terminal?.id ||
      terminal.exit !== null ||
      terminal.closing
    )
      return;
    await this.cancel(true);
  }
  async recheck(reconnect: () => Promise<void>) {
    if (authActive(this.value)) return;
    await this.check(reconnect);
  }
  async endConnection() {
    if (!authActive(this.value) || !this.endOperation) return;
    const id = this.value?.attemptId;
    this.startCancelled = true;
    this.update({ phase: "cancelling", error: null });
    try {
      await this.endOperation();
    } catch (error) {
      const current = this.getSnapshot();
      if (
        current?.attemptId === id &&
        authActive(current) &&
        current?.phase !== "checking"
      )
        this.update({ phase: "unknown", error });
    }
  }
}
