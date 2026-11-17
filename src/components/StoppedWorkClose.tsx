import { useEffect, useRef, useState } from "react";
import type { ThreadState } from "../runtime/session_types";
import { threads } from "../runtime/sessions";
import {
  currentWorkClose,
  failedWorkTarget,
  STOPPED_WORK_CLOSE as S,
  stoppedWorkTarget,
  unconfirmedStopTarget,
  type WorkCloseReceipt,
  type WorkCloseTarget,
} from "../runtime/stopped_work_close";

type Review =
  | { phase: "checking" | "closing" | "blocked" | "unconfirmed" }
  | { phase: "review"; proof: WorkCloseReceipt };

type Props = { thread: ThreadState; ownsView: () => boolean };

export function StoppedWorkClose(
  props: Props & { failed?: boolean; unconfirmed?: boolean },
) {
  const target = props.failed
    ? failedWorkTarget(props.thread)
    : props.unconfirmed
      ? unconfirmedStopTarget(props.thread)
      : stoppedWorkTarget(props.thread);
  if (!target) return null;
  const actions = (
    <EligibleClose key={JSON.stringify(target)} {...props} target={target} />
  );
  return props.failed ? (
    <div className="banner" role="status">
      <span>{S.failedNotice}</span>
      {actions}
    </div>
  ) : (
    actions
  );
}

function EligibleClose({
  thread,
  ownsView,
  target,
}: Props & {
  target: WorkCloseTarget;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const approved = useRef<WorkCloseReceipt | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      approved.current = null;
    };
  }, []);
  const owns = () =>
    mounted.current && ownsView() && currentWorkClose(thread, target);

  const check = async () => {
    if (!owns() || busy.current) return;
    busy.current = true;
    approved.current = null;
    setReview({ phase: "checking" });
    try {
      const proof = await threads.workConnectionClose.check(thread, target);
      if (owns()) {
        approved.current = proof;
        setReview(proof ? { phase: "review", proof } : { phase: "blocked" });
      }
    } catch {
      if (owns()) setReview({ phase: "blocked" });
    } finally {
      busy.current = false;
    }
  };

  const close = async () => {
    if (
      !owns() ||
      busy.current ||
      review?.phase !== "review" ||
      approved.current !== review.proof
    )
      return;
    busy.current = true;
    approved.current = null;
    setReview({ phase: "closing" });
    try {
      await threads.workConnectionClose.close(thread, target, review.proof);
    } catch {
      if (owns()) setReview({ phase: "unconfirmed" });
    } finally {
      busy.current = false;
    }
  };

  if (review?.phase === "review")
    return (
      <div>
        <p>{"unconfirmedStop" in target ? S.stopReview : S.review}</p>
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => {
            approved.current = null;
            setReview(null);
          }}
        >
          {S.cancel}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void close()}
        >
          {S.confirm}
        </button>
      </div>
    );
  return (
    <div>
      {review?.phase === "blocked" && <span>{S.blocked}</span>}
      {review?.phase === "unconfirmed" && <span>{S.unconfirmed}</span>}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={review?.phase === "checking" || review?.phase === "closing"}
        onClick={() => void check()}
      >
        {review?.phase === "checking"
          ? S.checking
          : review?.phase === "closing"
            ? S.closing
            : S.check}
      </button>
    </div>
  );
}
