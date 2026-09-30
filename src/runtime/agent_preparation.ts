import { useSyncExternalStore } from "react";
import {
  threads,
  hasPendingRequests,
  type SendAdmission,
  type ThreadState,
} from "./sessions";
import type { ServiceSelection } from "./credentials";
import type { AgentCardModel } from "./agents";
import { ACCESS_STRINGS as S } from "./access_strings";
import { uiError } from "./ui_error";
import { subscribeAuthenticationChanges } from "./authentication";
import type { AuthTarget } from "./auth_activity";

export interface PreparationInput {
  agentId: string;
  agentName: string;
  cwd: string;
  program: string;
  service: (ServiceSelection & { revision: string }) | null;
  config?: Record<string, unknown>;
}
export type PreparationPhase =
  | "untested"
  | "opening"
  | "submitting"
  | "running"
  | "needs_action"
  | "stopping"
  | "passed"
  | "failed"
  | "cancelled"
  | "unknown"
  | "stale";
export interface PreparationSnapshot {
  phase: PreparationPhase;
  input: PreparationInput | null;
  threadKey: string | null;
  config: Record<string, unknown>;
  prompt: string;
  reply: string;
  error: string | null;
  explicitReadTargets?: readonly string[];
}
type Port = Pick<
  typeof threads,
  | "open"
  | "thread"
  | "subscribeThread"
  | "send"
  | "cancel"
  | "discardDraft"
  | "dequeue"
  | "rename"
>;
type Attempt = {
  thread: ThreadState;
  base: number;
  marker: string;
  config: string;
  admission: SendAdmission | null;
  sending: boolean;
  cancelled: boolean;
};

export function preparationProgram(card: AgentCardModel): string {
  return JSON.stringify([
    card.id,
    card.programPath,
    card.discoveredPath,
    card.version,
    card.localVersion,
  ]);
}
function context(input: PreparationInput): string {
  return JSON.stringify([
    input.agentId,
    input.cwd,
    input.program,
    input.service,
  ]);
}
const readTarget = (target: AuthTarget) =>
  JSON.stringify([target.agentId, target.cwd, target.source ?? null]);
export function preparationNeedsExplicitRead(
  snapshot: PreparationSnapshot,
  input: PreparationInput,
): boolean {
  // Configuration actions use existing settings only. A different API source
  // may be prepared, but must not consume the original target's read gate.
  return (
    !input.service &&
    !!snapshot.explicitReadTargets?.includes(readTarget(input))
  );
}
export function preparationMatches(
  snapshot: PreparationSnapshot,
  input: PreparationInput,
): boolean {
  if (!preparationContextMatches(snapshot, input)) return false;
  // An explicit choice belongs to the caller. A previous preparation may fill
  // in omitted defaults, but must never replace a newly selected model/value.
  return Object.entries(input.config ?? {}).every(
    ([id, value]) =>
      JSON.stringify(snapshot.config[id]) === JSON.stringify(value),
  );
}
export function preparationContextMatches(
  snapshot: PreparationSnapshot,
  input: PreparationInput,
): boolean {
  return !!snapshot.input && context(snapshot.input) === context(input);
}
/** Failed reads belong to the requested choices, even when the Agent returned different values. */
export function preparationRequestMatches(
  snapshot: PreparationSnapshot,
  input: PreparationInput,
): boolean {
  return (
    preparationContextMatches(snapshot, input) &&
    configKey(snapshot.input?.config ?? {}) === configKey(input.config ?? {})
  );
}
function selectedConfig(thread: ThreadState): Record<string, unknown> {
  return Object.fromEntries(
    thread.configOptions.map((option) => [option.id, option.currentValue]),
  );
}
function configKey(config: Record<string, unknown>): string {
  return JSON.stringify(
    Object.entries(config).sort(([a], [b]) => a.localeCompare(b)),
  );
}
function outstanding(thread: ThreadState | undefined): boolean {
  return (
    !!thread &&
    (thread.running ||
      thread.submitting ||
      thread.stopping ||
      thread.stopUnconfirmed ||
      thread.connectionOutcomeUnknown ||
      !!thread.uncertainPrompt ||
      hasPendingRequests(thread))
  );
}
export const testInProgress = (phase: PreparationPhase) =>
  ["opening", "submitting", "running", "needs_action", "stopping"].includes(
    phase,
  );

/** Presentation owner only. Execution, events, approvals and cancellation stay in threads. */
export class AgentPreparation {
  private snapshot: PreparationSnapshot = {
    phase: "untested",
    input: null,
    threadKey: null,
    config: {},
    prompt: "",
    reply: "",
    error: null,
  };
  private listeners = new Set<() => void>();
  private revision = 0;
  private attempt: Attempt | null = null;
  private unsubscribe: (() => void) | undefined;
  private opening: Promise<void> | null = null;
  private marker = "";
  constructor(
    private readonly port: Port = threads,
    private readonly id: () => string = () => crypto.randomUUID(),
  ) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(change: Partial<PreparationSnapshot>) {
    this.snapshot = { ...this.snapshot, ...change };
    for (const listener of this.listeners) listener();
    notifyPreparations();
  }
  private currentThread() {
    return this.snapshot.threadKey
      ? this.port.thread(this.snapshot.threadKey)
      : undefined;
  }
  canPrepare() {
    return !this.attempt?.sending && !outstanding(this.currentThread());
  }
  requireExplicitRead(target: AuthTarget) {
    this.invalidate();
    this.publish({
      explicitReadTargets: [
        ...new Set([
          ...(this.snapshot.explicitReadTargets ?? []),
          readTarget(target),
        ]),
      ],
    });
  }
  verified(program: string): boolean {
    const thread = this.currentThread();
    return (
      this.snapshot.phase === "passed" &&
      this.snapshot.input?.program === program &&
      !!thread &&
      !thread.connectionLost &&
      !thread.sourceError &&
      !thread.modelDrift &&
      !thread.configuring &&
      configKey(selectedConfig(thread)) === this.attempt?.config
    );
  }

  prepare(input: PreparationInput, fresh = false): Promise<void> {
    if (!fresh && preparationNeedsExplicitRead(this.snapshot, input))
      return Promise.resolve();
    const same = preparationMatches(this.snapshot, input);
    if (!fresh && same && this.snapshot.phase === "opening")
      return this.opening ?? Promise.resolve();
    // Automatic reads and navigation retain this input's failure. Only the
    // explicit retry action (fresh) or a changed input starts another read.
    if (
      !fresh &&
      this.snapshot.phase === "failed" &&
      (same || preparationRequestMatches(this.snapshot, input))
    )
      return Promise.resolve();
    const existing = this.currentThread();
    if (
      !fresh &&
      same &&
      existing &&
      !existing.connectionLost &&
      !existing.openError &&
      (existing.identity === "draft" || this.snapshot.phase === "passed")
    )
      return Promise.resolve();
    if (this.attempt?.sending || outstanding(existing))
      return Promise.resolve();
    const ticket = ++this.revision;
    if (this.attempt) this.attempt.cancelled = true;
    this.attempt = null;
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    if (existing?.identity === "draft")
      void this.port.discardDraft(existing.key);
    this.marker = `FARFOLD-${this.id()}`;
    this.publish({
      phase: "opening",
      explicitReadTargets:
        fresh && !input.service
          ? this.snapshot.explicitReadTargets?.filter(
              (target) => target !== readTarget(input),
            )
          : this.snapshot.explicitReadTargets,
      input,
      threadKey: null,
      config: input.config ?? {},
      prompt: S.testPrompt(this.marker),
      reply: "",
      error: null,
    });
    const request = (async () => {
      try {
        const thread = await this.port.open({
          agentId: input.agentId,
          cwd: input.cwd,
          service: input.service,
          serviceRevision: input.service?.revision,
          configOptions: input.config ?? null,
          fresh: true,
          draftScope: `preparation:${input.agentId}:${ticket}:${this.id()}`,
        });
        if (ticket !== this.revision) {
          await this.port.discardDraft(thread.key);
          return;
        }
        const config = selectedConfig(thread);
        const applied = Object.entries(input.config ?? {}).every(
          ([id, value]) => JSON.stringify(config[id]) === JSON.stringify(value),
        );
        this.publish({
          phase: applied ? "untested" : "failed",
          threadKey: thread.key,
          config,
          error: applied ? null : S.testSelectionNotApplied,
        });
        this.unsubscribe = this.port.subscribeThread(thread.key, () =>
          this.observe(),
        );
        this.observe();
      } catch (error) {
        if (ticket === this.revision)
          this.publish({
            phase: "failed",
            error: uiError(error, S.testPrepareFailed),
          });
      } finally {
        if (ticket === this.revision) this.opening = null;
      }
    })();
    this.opening = request;
    return request;
  }

  async start(): Promise<void> {
    const thread = this.currentThread();
    if (
      !thread ||
      thread.identity !== "draft" ||
      outstanding(thread) ||
      thread.configuring ||
      thread.configError ||
      thread.modelDrift ||
      thread.connectionLost ||
      thread.openError ||
      !thread.workEnabled ||
      this.snapshot.phase !== "untested"
    )
      return;
    // Synchronous ownership prevents two clicks in the same React event batch.
    const attempt: Attempt = {
      thread,
      base: thread.items.length,
      marker: this.marker,
      config: configKey(selectedConfig(thread)),
      admission: null,
      sending: true,
      cancelled: false,
    };
    this.attempt = attempt;
    const blocks = [{ type: "text" as const, text: this.snapshot.prompt }];
    this.publish({ phase: "submitting", reply: "", error: null });
    try {
      attempt.admission = await this.port.send(thread.key, blocks);
      if (attempt.admission.status === "accepted") {
        // This is a normal, visible conversation; only its metadata is named here.
        void this.port
          .rename(
            thread.key,
            S.testTitle(this.snapshot.input?.agentName ?? thread.agentId),
          )
          .catch(() => undefined);
      } else if (
        attempt.admission.status === "rejected" ||
        attempt.admission.status === "queued"
      ) {
        const position = thread.queued.indexOf(blocks);
        if (position >= 0) this.port.dequeue(thread.key, position);
      }
    } catch (error) {
      attempt.admission = { status: "rejected", reason: "failed" };
      if (this.attempt === attempt)
        this.publish({ error: uiError(error, S.testFailed) });
    } finally {
      attempt.sending = false;
      // Never send cancel before a still-pending prompt admission can dispatch.
      if (attempt.cancelled && thread.running)
        await this.port.cancel(thread.key);
      if (this.attempt === attempt) this.observe();
    }
  }

  private observe() {
    const thread = this.currentThread();
    if (!thread) return;
    const config = selectedConfig(thread);
    const attempt = this.attempt;
    if (!attempt) {
      this.publish({
        config,
        ...(thread.connectionLost || thread.openError
          ? { phase: "stale" as const, error: S.testConnectionChanged }
          : {}),
      });
      return;
    }
    if (
      thread !== attempt.thread ||
      configKey(config) !== attempt.config ||
      thread.modelDrift ||
      thread.configuring
    ) {
      attempt.cancelled = true;
      this.publish({ phase: "stale", config, error: S.testSelectionChanged });
      return;
    }
    const items = thread.items.slice(attempt.base);
    const end = items.find((item) => item.kind === "settled");
    const reply = items
      .filter((item) => item.kind === "agent")
      .map((item) => (item.kind === "agent" ? item.text : ""))
      .join("");
    const common = { config, reply };
    if (attempt.cancelled) {
      this.publish({
        ...common,
        phase:
          thread.stopUnconfirmed ||
          thread.uncertainPrompt ||
          thread.connectionLost
            ? "unknown"
            : outstanding(thread) || attempt.sending
              ? "stopping"
              : "cancelled",
        error: null,
      });
    } else if (
      thread.connectionLost ||
      thread.sourceError ||
      attempt.admission?.status === "unknown" ||
      thread.stopUnconfirmed
    ) {
      this.publish({ ...common, phase: "unknown", error: S.testUnknown });
    } else if (
      attempt.admission?.status === "rejected" ||
      attempt.admission?.status === "queued"
    ) {
      this.publish({
        ...common,
        phase: "failed",
        error: this.snapshot.error ?? S.testNotAdmitted,
      });
    } else if (hasPendingRequests(thread)) {
      this.publish({ ...common, phase: "needs_action", error: null });
    } else if (
      attempt.admission?.status === "accepted" &&
      end?.kind === "settled"
    ) {
      const phase =
        end.status === "done" && reply.trim() === attempt.marker
          ? "passed"
          : end.status === "stopped"
            ? "cancelled"
            : end.status === "unknown"
              ? "unknown"
              : "failed";
      this.publish({
        ...common,
        phase,
        error:
          phase === "passed" || phase === "cancelled"
            ? null
            : (end.error ??
              (reply.trim() ? S.testUnexpectedReply : S.testNoReply)),
      });
    } else {
      this.publish({
        ...common,
        phase: attempt.sending ? "submitting" : "running",
      });
    }
  }

  /** Invalidate success synchronously, but retain execution ownership until it settles. */
  invalidate = (): void => {
    ++this.revision;
    const attempt = this.attempt;
    const end = attempt?.thread.items
      .slice(attempt.base)
      .find((item) => item.kind === "settled");
    // applyTurnEnd always records replyReceived, even for AUTH_REQUIRED with
    // no reply; a synthetic connection-loss ending has no such receipt field.
    if (
      attempt &&
      !attempt.sending &&
      !outstanding(attempt.thread) &&
      (attempt.admission?.status === "rejected" ||
        attempt.admission?.status === "queued" ||
        (end?.kind === "settled" &&
          end.status !== "unknown" &&
          end.replyReceived !== undefined))
    ) {
      // A completed test keeps its conversation, but no longer owns an active
      // attempt. Rechecking the account may now close this idle connection;
      // that later disconnect cannot make the old request's outcome unknown.
      this.attempt = null;
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.publish({ phase: "stale", error: null });
      return;
    }
    if (attempt) {
      attempt.cancelled = true;
      this.publish({
        phase:
          outstanding(attempt.thread) || attempt.sending ? "stopping" : "stale",
        error: null,
      });
      if (!attempt.sending && attempt.thread.running)
        void this.port.cancel(attempt.thread.key).then(() => this.observe());
    } else {
      const thread = this.currentThread();
      if (thread?.identity === "draft") void this.port.discardDraft(thread.key);
      this.unsubscribe?.();
      this.unsubscribe = undefined;
      this.publish({ phase: "stale", threadKey: null, error: null });
    }
  };
  stop = (): void => {
    this.invalidate();
    if (this.attempt) this.observe();
  };
}

const preparations = new Map<string, AgentPreparation>();
// All authentication entry points revoke existing results, including advanced settings.
// Ordinary connection/event observations never emit this user-action notification.
subscribeAuthenticationChanges((agentId) => {
  preparations.get(agentId)?.invalidate();
});
const listeners = new Set<() => void>();
let version = 0;
function notifyPreparations() {
  version++;
  for (const listener of listeners) listener();
}
export function preparationFor(agentId: string): AgentPreparation {
  let preparation = preparations.get(agentId);
  if (!preparation) {
    preparation = new AgentPreparation();
    preparations.set(agentId, preparation);
  }
  return preparation;
}
export function usePreparation(agentId: string) {
  const controller = preparationFor(agentId);
  return {
    controller,
    state: useSyncExternalStore(
      controller.subscribe,
      controller.getSnapshot,
      controller.getSnapshot,
    ),
  };
}
export function usePreparationChanges() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => version,
    () => version,
  );
}
