import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type {
  ArchiveIdentity,
  ArchivePrepareInput,
  ArchivePort,
  ArchiveReply,
  ArchiveCode,
  ArchiveStatus,
} from "./conversation_archive_types";
import { archiveCode, parseArchiveReply } from "./conversation_archive_parse";
import { sourceBytes } from "./conversation_archive_selection";
type Command = "start" | "status" | "cancel";
export interface ArchiveJob {
  identity: ArchiveIdentity;
  phase: "preparing" | "known" | "unconfirmed";
  reply: ArchiveReply | null;
  checking: boolean;
  cancelRequested: boolean;
  code: ArchiveCode | null;
  closeFailed: boolean;
}
const port: ArchivePort = {
  file_archive_prepare: (input) =>
    invoke("file_archive_prepare", input as unknown as Record<string, unknown>),
  file_archive_start: (input) => invoke("file_archive_start", { ...input }),
  file_archive_status: (input) => invoke("file_archive_status", { ...input }),
  file_archive_cancel: (input) => invoke("file_archive_cancel", { ...input }),
  file_archive_release: (input) => invoke("file_archive_release", { ...input }),
};
interface Owner {
  startAllowed: boolean;
  pending: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
  sequence: number;
  applied: number;
}
/** Safe observations only. Request bodies belong to the prepare call, not activity. */
export class ConversationArchiveJobs {
  private jobs: ArchiveJob[] = [];
  private owners = new Map<string, Owner>();
  private listeners = new Set<() => void>();
  constructor(
    private api: ArchivePort = port,
    private waitMs = 10000,
    private pollMs = 800,
  ) {}
  getSnapshot = () => this.jobs;
  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  };
  private find = (id: string) =>
    this.jobs.find((j) => j.identity.operationId === id);
  private patch(id: string, patch: Partial<ArchiveJob>) {
    this.jobs = this.jobs.map((j) =>
      j.identity.operationId === id ? { ...j, ...patch } : j,
    );
    this.listeners.forEach((fn) => fn());
  }
  hasUnsettled = () =>
    this.jobs.some(
      (j) =>
        !j.reply ||
        (j.reply.state === "absent"
          ? !j.reply.admissionClosed
          : !j.reply.settled),
    );
  hasUnknownFinished = () =>
    this.jobs.some(
      (j) =>
        j.reply?.state === "unknown" ||
        (j.reply?.state === "absent" && j.reply.admissionClosed),
    );
  private key(id: string) {
    const j = this.find(id)!;
    return { operationId: id, inputSha256: j.identity.inputSha256 };
  }
  private accept(id: string, value: unknown, sequence: number) {
    const job = this.find(id),
      owner = this.owners.get(id);
    if (!job || !owner || sequence < owner.applied) return;
    const next = parseArchiveReply(value, job.identity);
    if (
      job.reply &&
      (job.reply.state === "absent"
        ? job.reply.admissionClosed
        : job.reply.settled)
    )
      return;
    if (job.reply && job.reply.state !== "absent" && next.state !== "absent") {
      if (
        next.processedInputBytes < job.reply.processedInputBytes ||
        next.itemsCompleted < job.reply.itemsCompleted
      )
        return;
      if (job.reply.state !== "ready" && next.state === "ready") return;
    }
    owner.applied = sequence;
    this.patch(id, {
      reply: next,
      phase:
        next.state === "unknown" || next.state === "absent"
          ? "unconfirmed"
          : "known",
      code: next.state === "absent" ? null : next.code,
      checking: false,
    });
  }
  private uncertain(id: string, error: unknown, sequence: number) {
    const job = this.find(id);
    const owner = this.owners.get(id);
    if (
      !job ||
      !owner ||
      sequence < owner.applied ||
      (job.reply &&
        (job.reply.state === "absent"
          ? job.reply.admissionClosed
          : job.reply.settled))
    )
      return;
    this.patch(id, {
      phase: "unconfirmed",
      checking: false,
      code: archiveCode(error),
    });
  }
  private schedule(id: string) {
    const owner = this.owners.get(id),
      job = this.find(id);
    if (!owner || !job) return;
    if (owner.timer) clearTimeout(owner.timer);
    owner.timer = undefined;
    if (
      owner.pending.size ||
      job.phase !== "known" ||
      !job.reply ||
      job.reply.state === "absent" ||
      job.reply.settled ||
      job.reply.state === "ready"
    )
      return;
    owner.timer = setTimeout(() => {
      owner.timer = undefined;
      void this.check(id);
    }, this.pollMs);
  }
  /** Observer bound does not clear a real pending IPC; exact cancel remains separate. */
  private async observe(
    id: string,
    kind: string,
    promise: Promise<unknown>,
  ): Promise<boolean> {
    const owner = this.owners.get(id)!;
    owner.pending.add(kind);
    const sequence = ++owner.sequence;
    let expired = false,
      timer: ReturnType<typeof setTimeout> | undefined;
    const actual = promise
      .then(
        (value) => {
          try {
            this.accept(id, value, sequence);
          } catch (error) {
            this.uncertain(id, error, sequence);
          }
          return true;
        },
        (error) => {
          this.uncertain(id, error, sequence);
          return false;
        },
      )
      .finally(() => {
        owner.pending.delete(kind);
        if (timer) clearTimeout(timer);
        if (expired) {
          this.patch(id, { checking: false });
          this.schedule(id);
        }
      });
    const timely = await Promise.race([
      actual,
      new Promise<false>((resolve) => {
        timer = setTimeout(() => {
          expired = true;
          owner.startAllowed = false;
          this.uncertain(id, undefined, sequence);
          resolve(false);
        }, this.waitMs);
      }),
    ]);
    return timely && !expired;
  }
  begin(input: ArchivePrepareInput): string {
    const id = input.operationId;
    if (
      this.find(id) ||
      this.jobs.length >= 64 ||
      this.jobs.some(
        (j) =>
          j.identity.destination === input.destination &&
          (!j.reply ||
            j.reply.state === "unknown" ||
            j.reply.state === "absent" ||
            !j.reply.settled),
      )
    )
      throw { code: "busy" };
    const identity: ArchiveIdentity = {
      kind: "conversationArchive",
      operationId: id,
      inputSha256: input.inputSha256,
      snapshotId: input.snapshotId,
      selectionId: input.selectionId,
      destination: input.destination,
      includedCount: input.selected.length,
      omittedCount: input.omitted.length,
      totalInputBytes: input.selected.reduce(
        (n, s) => n + sourceBytes(s.source),
        0,
      ),
    };
    const owner: Owner = {
      startAllowed: true,
      pending: new Set(),
      sequence: 0,
      applied: 0,
    };
    this.owners.set(id, owner);
    this.jobs = [
      ...this.jobs,
      {
        identity,
        phase: "preparing",
        reply: null,
        checking: true,
        cancelRequested: false,
        code: null,
        closeFailed: false,
      },
    ];
    // The intent is registered before observers run or IPC can return synchronously.
    this.listeners.forEach((fn) => fn());
    void (async () => {
      try {
        const timely = await this.observe(
          id,
          "prepare",
          Promise.resolve().then(() => this.api.file_archive_prepare(input)),
        );
        const job = this.find(id);
        if (timely && owner.startAllowed && job?.reply?.state === "ready") {
          owner.startAllowed = false;
          await this.request(id, "start");
        }
      } finally {
        owner.startAllowed = false;
        this.patch(id, { checking: false });
        this.schedule(id);
      }
    })();
    return id;
  }
  private async request(id: string, kind: Command) {
    const owner = this.owners.get(id),
      job = this.find(id);
    if (!owner || !job) return;
    if (
      job.reply &&
      (job.reply.state === "absent"
        ? job.reply.admissionClosed
        : job.reply.settled)
    )
      return;
    if (
      owner.pending.has(kind) ||
      (kind !== "cancel" && owner.pending.size > 0)
    )
      return;
    if (owner.timer) clearTimeout(owner.timer);
    owner.timer = undefined;
    this.patch(id, { checking: true });
    await this.observe(
      id,
      kind,
      Promise.resolve().then(() =>
        this.api[`file_archive_${kind}`](this.key(id)),
      ),
    );
    this.patch(id, { checking: false });
    this.schedule(id);
  }
  check = (id: string) => this.request(id, "status");
  cancel = (id: string) => {
    const owner = this.owners.get(id);
    if (!owner) return Promise.resolve();
    owner.startAllowed = false;
    this.patch(id, { cancelRequested: true });
    return this.request(id, "cancel");
  };
  async dismiss(id: string, acknowledgeUnknown = false) {
    const owner = this.owners.get(id),
      job = this.find(id);
    if (!owner || !job || owner.pending.size) return;
    const unknown =
      job.reply?.state === "unknown" || job.reply?.state === "absent";
    if (
      !job.reply ||
      !job.reply.settled ||
      (job.reply.state === "absent" && !job.reply.admissionClosed) ||
      (unknown && !acknowledgeUnknown)
    )
      return;
    // A closed absent observation has no detailed backend record to release.
    // Acknowledgement only retires our exact observation, not a historical result.
    if (
      job.reply.state === "absent" &&
      job.reply.admissionClosed &&
      acknowledgeUnknown
    ) {
      if (owner.timer) clearTimeout(owner.timer);
      this.owners.delete(id);
      this.jobs = this.jobs.filter((j) => j.identity.operationId !== id);
      this.listeners.forEach((fn) => fn());
      return;
    }
    this.patch(id, { checking: true });
    owner.pending.add("release");
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // A late true only closes this exact settled result, never changes its outcome.
    const finish = (ok: boolean) => {
      owner.pending.delete("release");
      if (timeout) clearTimeout(timeout);
      if (ok) {
        if (owner.timer) clearTimeout(owner.timer);
        this.owners.delete(id);
        this.jobs = this.jobs.filter((j) => j.identity.operationId !== id);
        this.listeners.forEach((fn) => fn());
      } else this.patch(id, { checking: false, closeFailed: true });
    };
    const actual = Promise.resolve()
      .then(() => this.api.file_archive_release(this.key(id)))
      .then(
        (v) => finish(v === true),
        () => finish(false),
      );
    await Promise.race([
      actual,
      new Promise<void>((resolve) => {
        timeout = setTimeout(() => {
          this.patch(id, { checking: false, closeFailed: true });
          resolve();
        }, this.waitMs);
      }),
    ]);
  }
}
export const conversationArchiveJobs = new ConversationArchiveJobs();
export function useConversationArchiveJobs() {
  return useSyncExternalStore(
    conversationArchiveJobs.subscribe,
    conversationArchiveJobs.getSnapshot,
    conversationArchiveJobs.getSnapshot,
  );
}
