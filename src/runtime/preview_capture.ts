import type { VerifiedFile } from "./file_delivery";

export interface PreviewContentStatus {
  file: VerifiedFile;
  state: "loading" | "ready" | "failed" | "paused";
  code?: string;
}

export function samePreviewFile(a: VerifiedFile, b: VerifiedFile): boolean {
  return (
    [
      "root",
      "path",
      "resolvedPath",
      "name",
      "size",
      "version",
      "sha256",
    ] as const
  ).every((key) => a[key] === b[key]);
}

/** One child-owned bounded capture. Hiding cancels presentation, never the OS
 * receipt wait. A rejected receipt remains rejected until an explicit retry. */
export class PreviewCapture<T> {
  private attempt: {
    file: VerifiedFile;
    retry: number;
    settled: boolean;
    failed: boolean;
    promise: Promise<T>;
  } | null = null;
  read(
    file: VerifiedFile,
    retry: number,
    capture: (file: VerifiedFile, signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const previous = this.attempt;
    if (
      previous &&
      samePreviewFile(previous.file, file) &&
      (!previous.settled || !previous.failed || previous.retry === retry)
    ) {
      previous.retry = retry;
      return previous.promise;
    }
    const attempt = {
      file: { ...file },
      retry,
      settled: false,
      failed: false,
      promise: null! as Promise<T>,
    };
    this.attempt = attempt;
    // Deliberately independent of view visibility and parser cancellation.
    attempt.promise = Promise.resolve()
      .then(() => capture(file, new AbortController().signal))
      .then(
        (value) => {
          attempt.settled = true;
          return value;
        },
        (error) => {
          attempt.settled = true;
          attempt.failed = true;
          throw error;
        },
      );
    return attempt.promise;
  }
  release(file: VerifiedFile): void {
    if (
      this.attempt?.settled &&
      !this.attempt.failed &&
      samePreviewFile(this.attempt.file, file)
    )
      this.attempt = null;
  }
}
