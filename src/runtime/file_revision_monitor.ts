import type {
  FileRevisionCheck,
  FileRevisionFailureCode,
  VerifiedFile,
} from "./file_delivery";

export type RevisionNotice =
  FileRevisionFailureCode | "newVersion" | "refreshFailed";
export type RevisionApplyOutcome =
  "applied" | "deferred" | "failed" | "cancelled";
export interface RevisionTarget {
  identity: string;
  file: VerifiedFile;
  enabled: boolean;
  blocked: boolean;
}
export function sameFileRevision(left: VerifiedFile, right: VerifiedFile) {
  return (
    [
      "root",
      "path",
      "resolvedPath",
      "name",
      "size",
      "sha256",
      "version",
    ] as const
  ).every((key) => left[key] === right[key]);
}
function failureCode(error: unknown): FileRevisionFailureCode {
  const code =
    error && typeof error === "object" && "code" in error ? error.code : null;
  switch (code) {
    case "missing":
    case "redirected":
    case "changing":
    case "notFile":
    case "tooLarge":
    case "unreadable":
    case "pending":
    case "busy":
      return code;
    default:
      return "unavailable";
  }
}

/** One selected file only. No directory watch, persisted state, or OS-read retry loop. */
export class FileRevisionMonitor {
  private target: RevisionTarget | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private inFlight = false;
  private sequence = 0;
  private visible = true;
  private halted = false;
  private forceContent = false;
  private lastContentCheck = Date.now();

  constructor(
    private readonly services: {
      check: (
        file: VerifiedFile,
        mode: "hint" | "content",
      ) => Promise<FileRevisionCheck>;
      apply: (
        file: VerifiedFile,
        valid: () => boolean,
      ) => Promise<RevisionApplyOutcome>;
      notice: (notice: RevisionNotice | null) => void;
    },
  ) {}

  update(target: RevisionTarget | null) {
    const old = this.target;
    const changed =
      old?.identity !== target?.identity || old?.file !== target?.file;
    const resumed = !changed && Boolean(target?.enabled && !old?.enabled);
    if (changed) {
      this.sequence++;
      this.halted = false;
      // A newly displayed file has just been fully read. Its first timer is cheap.
      this.lastContentCheck = Date.now();
      this.forceContent = false;
      this.services.notice(null);
    } else if (old?.enabled && !target?.enabled) {
      this.sequence++;
    } else if (resumed) {
      this.forceContent = true;
    }
    this.target = target;
    this.schedule(resumed ? 0 : 5000);
  }

  setVisible(visible: boolean) {
    if (this.visible === visible) return;
    this.visible = visible;
    if (!visible) this.sequence++;
    else this.forceContent = true;
    this.schedule(visible ? 0 : 5000);
  }

  focus() {
    this.forceContent = true;
    this.schedule(0);
  }

  dispose() {
    this.sequence++;
    this.target = null;
    this.clearTimer();
  }

  private clearTimer() {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(delay: number) {
    this.clearTimer();
    if (
      !this.target?.enabled ||
      this.target.blocked ||
      !this.visible ||
      this.halted ||
      this.inFlight
    )
      return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.check();
    }, delay);
  }

  private async check() {
    const target = this.target;
    if (
      !target?.enabled ||
      target.blocked ||
      !this.visible ||
      this.halted ||
      this.inFlight
    )
      return;
    const sequence = this.sequence;
    const ownsFile = () =>
      this.target?.identity === target.identity &&
      this.target?.file === target.file;
    const valid = () =>
      ownsFile() &&
      this.sequence === sequence &&
      Boolean(this.target?.enabled) &&
      this.visible;
    const mode =
      this.forceContent || Date.now() - this.lastContentCheck >= 60000
        ? "content"
        : "hint";
    this.forceContent = false;
    this.inFlight = true;
    try {
      const result = await this.services.check(target.file, mode);
      if (!valid()) return;
      if (result.kind === "verified") {
        this.lastContentCheck = Date.now();
        if (!sameFileRevision(target.file, result.file)) {
          // A concurrent save/open owns its UI. Recheck after it completes.
          if (this.target?.blocked) {
            this.forceContent = true;
            return;
          }
          const outcome = await this.services.apply(result.file, valid);
          if (ownsFile() && outcome !== "applied" && outcome !== "cancelled") {
            this.halted = true;
            this.services.notice(
              outcome === "deferred" ? "newVersion" : "refreshFailed",
            );
          }
        }
      }
    } catch (error) {
      // Even a hidden view must retain an unresolved OS check. Reopening is not
      // permission to spawn another check while the first may still hold a slot.
      if (ownsFile()) {
        this.halted = true;
        this.services.notice(failureCode(error));
      }
    } finally {
      this.inFlight = false;
      this.schedule(this.forceContent ? 0 : 5000);
    }
  }
}
