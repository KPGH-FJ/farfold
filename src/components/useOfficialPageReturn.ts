import { useEffect, useRef, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { getCurrentWindow } from "@tauri-apps/api/window";

type PageStatus =
  | { owner: string | undefined; phase: "opening" | "opened" }
  | { owner: string | undefined; phase: "failed"; reason: unknown };

/** A foreground return authorizes one check of its initiating view only. */
export function useOfficialPageReturn(
  owner: string | undefined,
  active: boolean,
  disabled: boolean,
  onReturn?: () => void,
) {
  const current = useRef({ owner, active, disabled, onReturn });
  current.current = { owner, active, disabled, onReturn };
  const attempt = useRef<{
    owner: string | undefined;
    opened: boolean;
    departed: boolean;
    returned: boolean;
    checkOnReturn: boolean;
  } | null>(null);
  const [result, setResult] = useState<PageStatus | null>(null);
  const canCheck = !!onReturn;
  const checkReturn = () => {
    const opening = attempt.current;
    const view = current.current;
    if (
      !opening?.opened ||
      !opening.checkOnReturn ||
      !opening.returned ||
      opening.owner !== view.owner ||
      !view.active ||
      view.disabled ||
      !view.onReturn
    )
      return;
    attempt.current = null;
    view.onReturn();
  };

  useEffect(() => {
    setResult((previous) =>
      active && previous?.owner === owner ? previous : null,
    );
    let watching = active;
    let unlistenNative: (() => void) | undefined;
    const departed = () => {
      const opening = attempt.current;
      if (!watching || !opening || opening.owner !== owner) return;
      opening.departed = true;
      opening.returned = false;
    };
    const returned = () => {
      const opening = attempt.current;
      if (
        !watching ||
        !opening ||
        opening.owner !== owner ||
        (!opening.opened && !opening.departed)
      )
        return;
      opening.returned = true;
      checkReturn();
    };
    const view = typeof window === "undefined" ? null : window;
    const doc = typeof document === "undefined" ? null : document;
    const visibilityChanged = () => {
      if (doc?.visibilityState === "visible") returned();
      else departed();
    };
    if (watching) {
      view?.addEventListener("blur", departed);
      view?.addEventListener("focus", returned);
      doc?.addEventListener("visibilitychange", visibilityChanged);
      void Promise.resolve()
        .then(() =>
          watching
            ? getCurrentWindow().onFocusChanged(({ payload }) => {
                if (payload) returned();
                else departed();
              })
            : undefined,
        )
        .then((stop) => {
          if (watching) unlistenNative = stop;
          else stop?.();
        })
        .catch(() => undefined); // Keep the DOM listeners outside the desktop app.
    }
    return () => {
      watching = false;
      if (attempt.current?.owner === owner) attempt.current = null;
      view?.removeEventListener("blur", departed);
      view?.removeEventListener("focus", returned);
      doc?.removeEventListener("visibilitychange", visibilityChanged);
      unlistenNative?.();
    };
  }, [owner, active]);
  useEffect(() => {
    if (!canCheck && attempt.current) attempt.current.checkOnReturn = false;
    checkReturn();
  }, [owner, active, disabled, canCheck]);

  const open = async (url: string, checkOnReturn = true) => {
    const view = current.current;
    if (
      view.owner !== owner ||
      !view.active ||
      view.disabled ||
      (attempt.current && !attempt.current.opened)
    )
      return;
    const opening = {
      owner,
      opened: false,
      departed: false,
      returned: false,
      checkOnReturn: checkOnReturn && !!view.onReturn,
    };
    attempt.current = opening;
    setResult({ owner, phase: "opening" });
    const ownsOpen = () =>
      attempt.current === opening &&
      current.current.owner === owner &&
      current.current.active;
    try {
      await openUrl(url);
      if (!ownsOpen()) return;
      opening.opened = true;
      if (!opening.checkOnReturn || !current.current.onReturn)
        attempt.current = null;
      setResult({ owner, phase: "opened" });
      checkReturn();
    } catch (reason) {
      if (!ownsOpen()) return;
      attempt.current = null;
      setResult({ owner, phase: "failed", reason });
    }
  };
  const checkNow = () => {
    const view = current.current;
    if (view.owner !== owner || !view.active || view.disabled || !view.onReturn)
      return;
    attempt.current = null;
    view.onReturn();
  };
  const clear = () => {
    if (current.current.owner !== owner) return;
    attempt.current = null;
    setResult(null);
  };
  const status = active && result?.owner === owner ? result : null;
  return { status, open, checkNow, clear };
}
