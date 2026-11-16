import { useLayoutEffect, useRef } from "react";
import { fileCopyJobs, type FileCopyJob } from "../runtime/file_copy_jobs";
import {
  savedCopyTarget,
  type SavedCopyIntent,
} from "../runtime/file_copy_actions";
import { FILE_COPY_STRINGS as S } from "../runtime/file_copy_strings";

/** Shared by source previews and the global save history. No automatic opening. */
export function SavedCopyActions({
  job,
  active,
}: {
  job: FileCopyJob;
  active: boolean;
}) {
  const target = savedCopyTarget(job);
  const mounted = useRef(true),
    generation = useRef(0);
  const live = useRef({ active, stamp: target?.stamp });
  if ((!active && live.current.active) || live.current.stamp !== target?.stamp)
    generation.current += 1;
  live.current = { active, stamp: target?.stamp };
  useLayoutEffect(() => {
    mounted.current = true;
    const hide = () => {
      if (document.hidden) generation.current += 1;
    };
    document.addEventListener("visibilitychange", hide);
    return () => {
      mounted.current = false;
      generation.current += 1;
      document.removeEventListener("visibilitychange", hide);
    };
  }, []);
  if (!target) return null;
  const act = (kind: SavedCopyIntent) => {
    const token = generation.current,
      stamp = target.stamp;
    void fileCopyJobs.actOnSavedCopy(
      job.id,
      kind,
      () =>
        mounted.current &&
        live.current.active &&
        !document.hidden &&
        generation.current === token &&
        live.current.stamp === stamp,
    );
  };
  const action = job.savedAction;
  const unavailable = job.checking || action?.pending;
  const message = action?.pending
    ? S.checkingCopy
    : action?.code
      ? S.savedActionFailures[action.code]
      : action?.completed
        ? action.kind === "open"
          ? S.openedCopy
          : S.revealedCopy
        : "";
  return (
    <>
      <button
        type="button"
        className="btn btn-text"
        disabled={!active}
        aria-disabled={unavailable || undefined}
        onClick={() => act("open")}
      >
        {S.openCopy}
      </button>
      <button
        type="button"
        className="btn btn-text"
        disabled={!active}
        aria-disabled={unavailable || undefined}
        onClick={() => act("reveal")}
      >
        {S.revealCopy}
      </button>
      <span role="status" aria-atomic="true" style={{ flexBasis: "100%" }}>
        {message}
      </span>
    </>
  );
}
