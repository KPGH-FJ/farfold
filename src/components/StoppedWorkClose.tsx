import { useEffect, useRef, useState } from "react";
import type { ThreadState } from "../runtime/session_types";
import { threads } from "../runtime/sessions";
import {
  currentStoppedWork,
  STOPPED_WORK_CLOSE as S,
  stoppedWorkTarget,
  type StoppedWorkCloseReceipt,
  type StoppedWorkTarget,
} from "../runtime/stopped_work_close";

type Review =
  | { phase: "checking" | "closing" | "blocked" | "unconfirmed" }
  | { phase: "review"; proof: StoppedWorkCloseReceipt };

type Props = { thread: ThreadState; ownsView: () => boolean };

export function StoppedWorkClose(props: Props) {
  const target = stoppedWorkTarget(props.thread);
  return target ? (
    <EligibleClose key={JSON.stringify(target)} {...props} target={target} />
  ) : null;
}

function EligibleClose({
  thread,
  ownsView,
  target,
}: Props & {
  target: StoppedWorkTarget;
}) {
  const [review, setReview] = useState<Review | null>(null);
  const busy = useRef(false);
  const mounted = useRef(true);
  const approved = useRef<StoppedWorkCloseReceipt | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      approved.current = null;
    };
  }, []);
  const owns = () =>
    mounted.current && ownsView() && currentStoppedWork(thread, target);

  const check = async () => {
    if (!owns() || busy.current) return;
    busy.current = true;
    approved.current = null;
    setReview({ phase: "checking" });
    try {
      const proof = await threads.checkStoppedWorkClose(thread, target);
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
      await threads.closeStoppedWork(thread, target, review.proof);
    } catch {
      if (owns()) setReview({ phase: "unconfirmed" });
    } finally {
      busy.current = false;
    }
  };

  if (review?.phase === "review")
    return (
      <div>
        <p>{S.review}</p>
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
