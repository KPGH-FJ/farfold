import { useLayoutEffect, useRef, useState } from "react";
import {
  NotificationTest,
  NOTIFICATION_TEST as S,
  type NotificationTestState,
} from "../runtime/notification_test";

export function NotificationTestControl({
  ready,
  saving,
  error,
  sound,
}: {
  ready: boolean;
  saving: boolean;
  error: string | null;
  sound: boolean;
}) {
  const owner = useRef<NotificationTest | null>(null);
  const [state, setState] = useState<NotificationTestState>({
    phase: "idle",
    message: null,
  });
  useLayoutEffect(() => {
    const current = new NotificationTest(setState);
    owner.current = current;
    setState(current.state);
    return () => {
      current.release();
      if (owner.current === current) owner.current = null;
    };
  }, []);
  const allowed = ready && !saving && !error;
  const busy = state.phase === "pending";
  return (
    <div>
      <div className="general-setting-row">
        <div>
          <strong>{S.title}</strong>
          <p>{S.description}</p>
          <p>{sound ? S.soundOn : S.soundOff}</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!allowed}
          aria-disabled={busy || undefined}
          onClick={() => void owner.current?.send(Boolean(allowed))}
        >
          {busy ? S.sending : state.phase === "unknown" ? S.again : S.send}
        </button>
      </div>
      {state.message && (
        <p className="auth-note" role="status">
          {state.message}
        </p>
      )}
    </div>
  );
}
