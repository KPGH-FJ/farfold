import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  InterfaceScalePreference,
  INTERFACE_SCALES,
  INTERFACE_SCALE_STRINGS as S,
  isInterfaceScale,
  type InterfaceScale,
  type InterfaceScaleState,
} from "../runtime/interface_scale";
import { primaryShortcutHeld } from "../runtime/platform_shortcuts";
import { browserSurfaceGuard } from "../runtime/browser_surface";
import { InterfaceZoom } from "../runtime/interface_scale_native";
import "../interface-scale.css";

const Context = createContext<InterfaceScalePreference | null>(null);
const fallback: InterfaceScaleState = {
  value: 100,
  ready: false,
  saving: false,
  error: null,
  errorKind: null,
};
const subscribeFallback = () => () => {};
const getFallback = () => fallback;
const nativeZoom = new InterfaceZoom(browserSurfaceGuard);

export function InterfaceScaleProvider({ children }: { children: ReactNode }) {
  const [preference, setPreference] = useState<InterfaceScalePreference | null>(
    null,
  );
  useLayoutEffect(() => {
    const owner = new InterfaceScalePreference((value) =>
      nativeZoom.apply(value),
    );
    setPreference(owner);
    void owner.load();
    const key = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        event.keyCode === 229 ||
        event.altKey ||
        !primaryShortcutHeld(event) ||
        (event.target instanceof Element && event.target.closest(".xterm"))
      )
        return;
      const state = owner.getSnapshot();
      if (!state.ready) return;
      const index = INTERFACE_SCALES.indexOf(state.value);
      let value: InterfaceScale | undefined;
      if (event.key === "+" || event.key === "=")
        value =
          INTERFACE_SCALES[Math.min(index + 1, INTERFACE_SCALES.length - 1)];
      else if (event.key === "-")
        value = INTERFACE_SCALES[Math.max(0, index - 1)];
      else if (event.key === "0") value = 100;
      if (value === undefined) return;
      event.preventDefault();
      void owner.save(value);
    };
    window.addEventListener("keydown", key);
    return () => {
      owner.release();
      window.removeEventListener("keydown", key);
    };
  }, []);
  return (
    <Context.Provider value={preference}>
      {children}
      <InterfaceScaleError />
    </Context.Provider>
  );
}

function useScale() {
  const owner = useContext(Context);
  const state = useSyncExternalStore(
    owner?.subscribe ?? subscribeFallback,
    owner?.getSnapshot ?? getFallback,
    getFallback,
  );
  return { owner, state };
}
function InterfaceScaleError() {
  const { owner, state } = useScale();
  if (!state.error) return null;
  return (
    <div className="interface-scale-error" role="alert">
      <span>{state.error}</span>
      {state.errorKind === "load" && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void owner?.load()}
        >
          {S.retry}
        </button>
      )}
      {state.errorKind === "apply" && (
        <button
          type="button"
          className="btn btn-ghost"
          onClick={() => void owner?.retryApply()}
        >
          {S.applyRetry}
        </button>
      )}
    </div>
  );
}
export function InterfaceScaleControl() {
  const { owner, state } = useScale();
  return (
    <div className="general-setting-row interface-scale-control">
      <div>
        <strong>
          <label htmlFor="interface-scale">{S.label}</label>
        </strong>
        <p>{S.hint}</p>
        <p role="status">
          {state.saving
            ? S.saving
            : !state.ready && !state.error
              ? S.loading
              : null}
        </p>
      </div>
      <select
        id="interface-scale"
        value={state.value}
        disabled={!state.ready}
        aria-disabled={state.saving || undefined}
        onChange={(event) => {
          const value = Number(event.target.value);
          if (isInterfaceScale(value) && !state.saving) void owner?.save(value);
        }}
      >
        {INTERFACE_SCALES.map((value) => (
          <option key={value} value={value}>
            {value}%
          </option>
        ))}
      </select>
    </div>
  );
}
