import { invoke } from "@tauri-apps/api/core";
import { readElicitation, replyToElicitation } from "./elicitation";
import { INQUIRY as S } from "./elicitation_strings";
import type { PendingElicitation } from "./session_types";

export interface OpeningInquiryView {
  id: string;
  agentId: string;
  cwd: string;
  requests: PendingElicitation[];
  ended: boolean;
  notice?: string;
  details?: unknown;
}

/** Transient replies while session/new or load is waiting for its first result.
 * This is not a transcript and never supplies history or authentication proof. */
export class OpeningInquiryOwner {
  private view: OpeningInquiryView;
  private available = true;
  private epoch = 0;
  private cleanup: (() => void)[] = [];
  private interested: (() => boolean)[] = [];
  constructor(
    agentId: string,
    cwd: string,
    private publish: () => void,
  ) {
    this.view = {
      id: crypto.randomUUID(),
      agentId,
      cwd,
      requests: [],
      ended: false,
    };
  }
  snapshot() {
    return this.view;
  }
  addInterest(current?: () => boolean, signal?: AbortSignal) {
    if (!this.available) return;
    this.interested.push(() => !signal?.aborted && (current?.() ?? true));
    if (signal) {
      const abort = () => {
        ++this.epoch;
        // A coalesced owner may acquire a new still-current caller in this
        // commit. The aborted caller's pending opener can never submit later.
        queueMicrotask(() => {
          if (!this.current()) this.retire();
        });
      };
      signal.addEventListener("abort", abort, { once: true });
      this.cleanup.push(() => signal.removeEventListener("abort", abort));
      if (signal.aborted) abort();
    }
  }
  private current() {
    return this.available && this.interested.some((fn) => fn());
  }
  private update(patch: Partial<OpeningInquiryView>) {
    this.view = { ...this.view, ...patch };
    this.publish();
  }
  receive(value: unknown): boolean {
    if (!value || typeof value !== "object") return false;
    const event = value as Record<string, unknown>;
    if (event.kind === "elicitation") {
      const item = readElicitation(event);
      if (!item) return false;
      if (!this.current()) {
        this.cancelReply(item);
        return true;
      }
      this.update({ requests: [...this.view.requests, item] });
      return true;
    }
    if (
      event.kind === "elicitationComplete" ||
      event.kind === "interactionExpired"
    ) {
      if (!this.view.requests.some((p) => p.requestId === event.requestId))
        return false;
      this.update({
        requests: this.view.requests.filter(
          (p) => p.requestId !== event.requestId,
        ),
        notice: event.kind === "elicitationComplete" ? S.complete : S.expired,
      });
      return true;
    }
    if (event.kind === "elicitationUnavailable") {
      if (this.current())
        this.update({ notice: S.unavailable, details: event.params });
      // Keep the normal channel's details and non-configuration queue pause.
      // Presenting this notice does not consume the unsupported request event.
      return false;
    }
    return false;
  }
  private cancelReply(p: PendingElicitation) {
    // Explicit abandonment of this local opening never invents an acceptance.
    void invoke("session_elicitation_respond", {
      requestId: p.requestId,
      sessionId: p.owner?.sessionId ?? null,
      requestOwner: p.owner,
      action: "cancel",
      content: null,
    }).catch(() => undefined);
  }
  retire() {
    if (!this.available) return;
    this.available = false;
    this.interested = [];
    this.cleanup.splice(0).forEach((fn) => fn());
    this.view.requests.forEach((p) => this.cancelReply(p));
    this.update({
      requests: [],
      ended: true,
      ...(this.view.requests.length ? { notice: S.closed } : {}),
    });
  }
  finish(failed = false) {
    this.available = false;
    this.interested = [];
    this.cleanup.splice(0).forEach((fn) => fn());
    this.update({
      requests: [],
      ended: true,
      ...(failed && (this.view.requests.length || this.view.notice)
        ? { notice: S.openEnded }
        : {}),
    });
  }
  edit(id: string, name: string, value: unknown) {
    const p = this.view.requests.find((p) => p.requestId === id);
    if (!p || !this.current() || p.status !== "pending") return;
    p.values[name] = value;
    this.update({ requests: [...this.view.requests] });
  }
  reply(
    id: string,
    action: "accept" | "decline" | "cancel",
    values?: Record<string, unknown>,
  ) {
    const p = this.view.requests.find((p) => p.requestId === id);
    if (!p) return Promise.resolve();
    const epoch = this.epoch;
    return replyToElicitation(p, action, values, {
      current: () =>
        epoch === this.epoch &&
        this.current() &&
        this.view.requests.includes(p),
      sessionId:
        typeof p.owner?.sessionId === "string" ? p.owner.sessionId : null,
      changed: () => this.update({ requests: [...this.view.requests] }),
      remove: (notice) =>
        this.update({
          requests: this.view.requests.filter((item) => item !== p),
          ...(notice ? { notice } : {}),
        }),
    });
  }
}

class OpeningInquiries {
  private owners = new Map<string, OpeningInquiryOwner>();
  private listeners = new Set<() => void>();
  private snapshot: OpeningInquiryView[] = [];
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  getSnapshot = () => this.snapshot;
  private publish = () => {
    const ended = [...this.owners.entries()].filter(
      ([, owner]) => owner.snapshot().ended,
    );
    for (const [key] of ended.slice(0, -16)) this.owners.delete(key);
    this.snapshot = [...this.owners.values()]
      .map((owner) => owner.snapshot())
      .filter((item) => item.requests.length || item.notice);
    this.listeners.forEach((fn) => fn());
  };
  begin(
    key: string,
    input: {
      agentId: string;
      cwd: string;
      inquiryCurrent?: () => boolean;
      inquirySignal?: AbortSignal;
    },
  ) {
    const owner = new OpeningInquiryOwner(
      input.agentId,
      input.cwd,
      this.publish,
    );
    owner.addInterest(input.inquiryCurrent, input.inquirySignal);
    this.owners.set(key, owner);
    return owner;
  }
  join(key: string, current?: () => boolean, signal?: AbortSignal) {
    this.owners.get(key)?.addInterest(current, signal);
  }
  owner(id: string) {
    return [...this.owners.values()].find((item) => item.snapshot().id === id);
  }
  dismiss(id: string) {
    for (const [key, owner] of this.owners)
      if (owner.snapshot().id === id && owner.snapshot().ended)
        this.owners.delete(key);
    this.publish();
  }
  retireAll = () => {
    for (const owner of this.owners.values()) owner.retire();
  };
}
export const openingInquiries = new OpeningInquiries();
