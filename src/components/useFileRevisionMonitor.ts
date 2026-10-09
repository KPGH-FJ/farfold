import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { fileDelivery, type VerifiedFile } from "../runtime/file_delivery";
import {
  FileRevisionMonitor,
  type RevisionNotice,
  type RevisionApplyOutcome,
} from "../runtime/file_revision_monitor";

export function useFileRevisionMonitor(options: {
  identity: string;
  file?: VerifiedFile;
  active: boolean;
  blocked: boolean;
  apply: (
    file: VerifiedFile,
    valid: () => boolean,
  ) => Promise<RevisionApplyOutcome>;
}) {
  const latest = useRef(options);
  latest.current = options;
  const [notice, setNotice] = useState<RevisionNotice | null>(null);
  const instance = useRef<FileRevisionMonitor | null>(null);
  if (!instance.current)
    instance.current = new FileRevisionMonitor({
      check: (file, mode) => fileDelivery.checkRevision(file, mode),
      apply: (file, valid) => latest.current.apply(file, valid),
      notice: setNotice,
    });
  const monitor = instance.current;
  useLayoutEffect(() => {
    monitor.update(
      options.file
        ? {
            identity: options.identity,
            file: options.file,
            enabled: options.active,
            blocked: options.blocked,
          }
        : null,
    );
  }, [
    monitor,
    options.identity,
    options.file,
    options.active,
    options.blocked,
  ]);
  useEffect(() => {
    if (typeof document === "undefined" || typeof window === "undefined")
      return () => monitor.dispose();
    const visibility = () =>
      monitor.setVisible(document.visibilityState !== "hidden");
    const focus = () => monitor.focus();
    visibility();
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("focus", focus);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("focus", focus);
      monitor.dispose();
    };
  }, [monitor]);
  return notice;
}
