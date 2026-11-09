import { conversationArchiveJobs } from "./conversation_archive_jobs";
import { invoke } from "@tauri-apps/api/core";
import { useSyncExternalStore } from "react";
import type { VerifiedFile } from "./file_delivery";
import { samePreviewFile } from "./preview_capture";
import {
  copyFailureCode,
  isCopyAbsence,
  copyTerminal,
  parseCopyStatus,
  type CopyStatus,
  type CopyFailureCode,
} from "./file_copy_types";
export interface FileCopyJob {
  id: number;
  file: VerifiedFile;
  destination: string;
  phase: "preparing" | "known" | "uncertain" | "notStarted";
  status?: CopyStatus;
  checking: boolean;
  code?: CopyFailureCode;
  closeFailed?: boolean;
  /** Exact-ID absence is a current no-IO proof, not a historical result. */
  absence?: true;
}
interface CopyApi {
  prepare(file: VerifiedFile, destination: string): Promise<unknown>;
  start(operationId: string): Promise<unknown>;
  status(operationId: string): Promise<unknown>;
  cancel(operationId: string): Promise<unknown>;
  release(operationId: string): Promise<unknown>;
}
const api: CopyApi = {
  prepare: (file, destination) =>
    invoke("file_copy_prepare", { file, destination }),
  start: (operationId) => invoke("file_copy_start", { operationId }),
  status: (operationId) => invoke("file_copy_status", { operationId }),
  cancel: (operationId) => invoke("file_copy_cancel", { operationId }),
  release: (operationId) => invoke("file_copy_release", { operationId }),
};
const EXPIRED = Symbol("observation expired");
/** One in-memory observer shared by every delivery entry. It owns no file body. */
export class FileCopyJobs {
  private items: FileCopyJob[] = [];
  private listeners = new Set<() => void>();
  private next = 0;
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private flights = new Set<number>();
  private cancelRequested = new Set<number>();
  private epochs = new Map<number, number>();
  private started = new Set<number>();
  constructor(
    private port: CopyApi = api,
    private pollMs = 800,
    private waitMs = 10_000,
  ) {}
  getSnapshot = () => this.items;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private change(job: FileCopyJob) {
    this.items = this.items.map((j) => (j.id === job.id ? job : j));
    this.listeners.forEach((l) => l());
  }
  private find(id: number) {
    return this.items.find((j) => j.id === id);
  }
  private stopTimer(id: number) {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  hasUnsettled = () =>
    this.items.some(
      (j) =>
        j.phase !== "notStarted" &&
        !j.absence &&
        !(j.status?.state === "unknown" && j.status.settled) &&
        (j.phase !== "known" || !j.status || !copyTerminal(j.status.state)),
    );
  /** A late reservation belongs to a withdrawn intent even after its UI closed. */
  private async retirePreparation(
    job: FileCopyJob,
    value: unknown,
  ): Promise<void> {
    let ready: CopyStatus;
    try {
      ready = parseCopyStatus(value, job.file, job.destination);
      if (ready.state !== "ready") throw new Error("Unexpected prepared copy");
    } catch (error) {
      this.failed(job.id, error);
      return;
    }
    const retain = () => {
      const current = this.find(job.id);
      const next: FileCopyJob = {
        ...(current ?? job),
        phase: "notStarted",
        status: ready,
        checking: false,
        code: "unavailable",
      };
      if (current) this.change(next);
      else {
        this.items = [...this.items, next];
        this.listeners.forEach((l) => l());
      }
    };
    const finish = async (ok: boolean, value: unknown) => {
      if (!ok) {
        retain();
        return;
      }
      try {
        if (isCopyAbsence(value, ready.operationId)) {
          const current = this.find(job.id);
          if (current)
            this.change({
              ...current,
              phase: "notStarted",
              checking: false,
              absence: true,
            });
          return;
        }
        const status = parseCopyStatus(
          value,
          job.file,
          job.destination,
          ready.operationId,
        );
        if (status.state !== "cancelled") {
          retain();
          return;
        }
        const current = this.find(job.id);
        if (current) {
          this.accept(current, status);
          return;
        }
        const released = await this.bounded(
          this.port.release(status.operationId),
          () => {},
        );
        if (released !== true) retain();
      } catch {
        retain();
      }
    };
    try {
      const result = await this.bounded(
        this.port.cancel(ready.operationId),
        (ok, value) => {
          void finish(ok, value);
        },
      );
      if (result === EXPIRED) retain();
      else await finish(true, result);
    } catch {
      retain();
    }
  }
  private accept(
    job: FileCopyJob,
    value: unknown,
    allowAbsence = false,
  ): FileCopyJob {
    if (job.absence || job.status?.settled) return job;
    if (
      allowAbsence &&
      job.status &&
      isCopyAbsence(value, job.status.operationId)
    ) {
      const next: FileCopyJob = {
        ...job,
        phase: "uncertain",
        absence: true,
        checking: false,
        code: undefined,
      };
      this.change(next);
      return next;
    }
    const status = parseCopyStatus(
      value,
      job.file,
      job.destination,
      job.status?.operationId,
    );
    // Do not let a late reply regress an observed terminal receipt.
    if (job.status?.settled) return job;
    const phase =
      status.state === "unknown" ||
      (status.state === "ready" && this.started.has(job.id))
        ? "uncertain"
        : "known";
    const next: FileCopyJob = {
      ...job,
      phase,
      status,
      checking: false,
      code: status.code,
    };
    this.change(next);
    return next;
  }
  private failed(id: number, error: unknown) {
    const job = this.find(id);
    if (!job || job.absence || job.status?.settled) return;
    this.change({
      ...job,
      phase: job.status ? "uncertain" : "notStarted",
      checking: false,
      code: copyFailureCode(error),
    });
  }
  private schedule(job: FileCopyJob) {
    this.stopTimer(job.id);
    if (
      job.phase === "known" &&
      job.status &&
      !copyTerminal(job.status.state) &&
      job.status.state !== "ready"
    ) {
      this.timers.set(
        job.id,
        setTimeout(() => {
          this.timers.delete(job.id);
          void this.check(job.id);
        }, this.pollMs),
      );
    }
  }
  private async bounded(
    promise: Promise<unknown>,
    late: (ok: boolean, value: unknown) => void,
  ): Promise<unknown | typeof EXPIRED> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const value = await Promise.race([
        promise,
        new Promise<typeof EXPIRED>((resolve) => {
          timer = setTimeout(() => resolve(EXPIRED), this.waitMs);
        }),
      ]);
      if (value === EXPIRED)
        void promise.then(
          (value) => late(true, value),
          (error) => late(false, error),
        );
      return value;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async begin(file: VerifiedFile, destination: string): Promise<void> {
    const existing = this.items.find(
      (job) =>
        job.destination === destination &&
        job.phase !== "notStarted" &&
        (job.phase !== "known" ||
          !job.status ||
          !copyTerminal(job.status.state)),
    );
    if (existing) {
      if (!samePreviewFile(existing.file, file)) throw { code: "busy" };
      return;
    }
    if (this.items.length >= 64) throw { code: "busy" };
    const job: FileCopyJob = {
      id: ++this.next,
      file: { ...file },
      destination,
      phase: "preparing",
      checking: true,
    };
    this.items = [...this.items, job];
    this.listeners.forEach((l) => l());
    this.flights.add(job.id);
    let ownsPrepare = true;
    try {
      const value = await this.bounded(
        this.port.prepare(file, destination),
        (ok, value) => {
          if (ok) void this.retirePreparation(job, value);
          else this.failed(job.id, value);
        },
      );
      if (value === EXPIRED) {
        this.cancelRequested.delete(job.id);
        this.change({ ...job, phase: "notStarted", checking: false });
        return;
      }
      const prepared = parseCopyStatus(value, job.file, job.destination);
      if (prepared.state !== "ready")
        throw new Error("Unexpected prepared copy");
      this.accept(job, prepared);
      this.flights.delete(job.id);
      ownsPrepare = false;
      if (this.cancelRequested.delete(job.id)) await this.cancel(job.id);
      else {
        this.started.add(job.id);
        await this.request(job.id, "start");
      }
    } catch (error) {
      this.failed(job.id, error);
    } finally {
      if (ownsPrepare) this.flights.delete(job.id);
    }
  }
  private async request(
    id: number,
    kind: "start" | "status" | "cancel",
  ): Promise<void> {
    let job = this.find(id);
    if (
      !job?.status ||
      job.absence ||
      this.flights.has(id) ||
      job.status.settled
    )
      return;
    this.stopTimer(id);
    this.flights.add(id);
    this.change({ ...job, checking: true });
    const epoch = (this.epochs.get(id) ?? 0) + 1;
    this.epochs.set(id, epoch);
    const apply = (ok: boolean, value: unknown) => {
      const current = this.find(id);
      if (!current || this.epochs.get(id) !== epoch) return;
      try {
        if (ok) this.schedule(this.accept(current, value, true));
        else this.failed(id, value);
      } catch (error) {
        this.failed(id, error);
      }
    };
    try {
      const value = await this.bounded(
        this.port[kind](job.status.operationId),
        apply,
      );
      if (value === EXPIRED) {
        this.failed(id, undefined);
        return;
      }
      apply(true, value);
    } catch (error) {
      apply(false, error);
    } finally {
      this.flights.delete(id);
      job = this.find(id);
      if (
        this.cancelRequested.delete(id) &&
        job?.status &&
        !copyTerminal(job.status.state)
      )
        void this.cancel(id);
    }
  }
  check = (id: number) => this.request(id, "status");
  cancel = async (id: number): Promise<void> => {
    const job = this.find(id);
    if (
      !job ||
      job.phase === "notStarted" ||
      (job.status && copyTerminal(job.status.state))
    )
      return;
    if (this.flights.has(id) || !job.status) {
      this.cancelRequested.add(id);
      return;
    }
    this.cancelRequested.delete(id);
    await this.request(id, "cancel");
  };
  async dismiss(id: number, acknowledgeUnknown = false): Promise<void> {
    const job = this.find(id);
    if (
      !job ||
      this.flights.has(id) ||
      (job.phase !== "notStarted" &&
        !(
          acknowledgeUnknown &&
          (job.absence ||
            (job.status?.state === "unknown" && job.status.settled))
        ) &&
        (job.phase !== "known" ||
          !job.status ||
          !copyTerminal(job.status.state)))
    )
      return;
    const remove = () => {
      this.stopTimer(id);
      this.started.delete(id);
      this.epochs.delete(id);
      this.cancelRequested.delete(id);
      this.items = this.items.filter((j) => j.id !== id);
      this.listeners.forEach((l) => l());
    };
    if (!job.status || job.absence) {
      remove();
      return;
    }
    this.flights.add(id);
    this.change({ ...job, checking: true, closeFailed: false });
    try {
      const result = await this.bounded(
        this.port.release(job.status.operationId),
        (ok, value) => {
          if (ok && value === true) remove();
        },
      );
      if (result === true) remove();
      else this.change({ ...job, checking: false, closeFailed: true });
    } catch {
      this.change({ ...job, checking: false, closeFailed: true });
    } finally {
      this.flights.delete(id);
    }
  }
  forFile(file: VerifiedFile) {
    return this.items.filter((j) => samePreviewFile(j.file, file));
  }
}
export const fileCopyJobs = new FileCopyJobs();
export const hasUnsettledFileCopies = () =>
  fileCopyJobs.hasUnsettled() || conversationArchiveJobs.hasUnsettled();
export function useFileCopyJobs() {
  return useSyncExternalStore(
    fileCopyJobs.subscribe,
    fileCopyJobs.getSnapshot,
    fileCopyJobs.getSnapshot,
  );
}
