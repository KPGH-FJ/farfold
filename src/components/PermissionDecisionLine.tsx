import { useEffect, useState } from "react";
import { STRINGS } from "../runtime/strings";

export function DecisionLine({
  decision,
  onUndo,
  submitting = false,
}: {
  decision: { label: string; allow: boolean; undoable: boolean };
  onUndo: () => void;
  submitting?: boolean;
}) {
  const [left, setLeft] = useState(5);
  useEffect(() => {
    if (!decision.undoable) return;
    const timer = window.setInterval(
      () => setLeft((v) => Math.max(0, v - 1)),
      1000,
    );
    return () => window.clearInterval(timer);
  }, [decision.undoable]);
  return (
    <div className="settled">
      <span
        className={
          submitting || decision.undoable
            ? undefined
            : decision.allow
              ? "ok"
              : "no"
        }
      >
        {!submitting && !decision.undoable && (decision.allow ? "✓ " : "✗ ")}
        {submitting
          ? STRINGS.repair.interactionSubmitting
          : decision.undoable
            ? STRINGS.thread.decisionWaiting
            : decision.label}
      </span>
      {decision.undoable && (
        <button type="button" className="undo" onClick={onUndo}>
          {STRINGS.thread.undo} {STRINGS.thread.secondsLeft(left)}
        </button>
      )}
    </div>
  );
}
