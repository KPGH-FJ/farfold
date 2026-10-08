import React, {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  CaretDown,
  Check,
  CircleNotch,
  ShieldCheck,
  WarningCircle,
} from "@phosphor-icons/react";
import { permissionOption, permissionOptions } from "./permission-state.js";
import "./permission-control.css";

export default function PermissionControl({
  capability,
  value,
  disabled = false,
  disabledReason = "",
  active = true,
  onChange,
}) {
  const options = permissionOptions(capability);
  const current = permissionOption(capability, value);
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState(null);
  const [position, setPosition] = useState(null);
  const trigger = useRef(null);
  const panel = useRef(null);
  const request = useRef(0);
  const pendingRef = useRef(false);
  const latest = useRef({ capability, value, disabled, active, onChange });
  latest.current = { capability, value, disabled, active, onChange };
  const menuId = useId();
  const blocked = disabled || pending || typeof onChange !== "function";
  const reason = pending
    ? "正在确认更改…"
    : disabled
      ? disabledReason || "当前暂不能更改权限"
      : typeof onChange !== "function"
        ? "当前仅可查看权限"
        : "";

  const close = (restoreFocus = false) => {
    setOpen(false);
    setCandidate(null);
    if (restoreFocus && latest.current.active) trigger.current?.focus();
  };

  useEffect(() => {
    request.current += 1;
    pendingRef.current = false;
    setPending(false);
    setCandidate(null);
    setFailure(null);
    setOpen(false);
    return () => {
      request.current += 1;
    };
  }, [capability?.id]);

  useEffect(() => {
    setCandidate(null);
    setFailure(null);
  }, [value]);

  useEffect(() => {
    if (!active) {
      setOpen(false);
      setCandidate(null);
    }
  }, [active]);

  useLayoutEffect(() => {
    if (!open || !active) return;
    const place = () => {
      const rect = trigger.current?.getBoundingClientRect();
      if (!rect) return;
      const width = Math.min(348, window.innerWidth - 24);
      const above = rect.top - 16;
      const below = window.innerHeight - rect.bottom - 16;
      setPosition({
        width,
        left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)),
        ...(above >= 260 || above >= below
          ? { bottom: window.innerHeight - rect.top + 8, maxHeight: above }
          : { top: rect.bottom + 8, maxHeight: below }),
      });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, active]);

  useEffect(() => {
    if (!open || !active) return;
    const outside = (event) => {
      if (
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("focusin", outside);
    const first = candidate
      ? panel.current?.querySelector("[data-permission-cancel]")
      : panel.current?.querySelector('[aria-checked="true"]') ||
        panel.current?.querySelector('[role="menuitemradio"]');
    first?.focus();
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("focusin", outside);
    };
  }, [open, candidate, active]);

  async function change(option) {
    const state = latest.current;
    const selected = permissionOption(state.capability, option.value);
    if (
      pendingRef.current ||
      !state.active ||
      state.disabled ||
      typeof state.onChange !== "function" ||
      !selected ||
      selected.value === state.value
    )
      return;
    const token = ++request.current;
    pendingRef.current = true;
    setPending(true);
    setFailure(null);
    try {
      await state.onChange(selected.value);
      if (token === request.current) close(true);
    } catch (error) {
      if (token === request.current) {
        const unknown = error?.code === "permission_unknown";
        setFailure({
          value: selected.value,
          unknown,
          message: unknown
            ? "权限更改结果未确认，请重新确认本次权限。"
            : "更改未完成，仍保留原权限。",
        });
        setCandidate(null);
        if (latest.current.active) setOpen(true);
      }
    } finally {
      if (token === request.current) {
        pendingRef.current = false;
        setPending(false);
      }
    }
  }

  function choose(option) {
    if (blocked) return;
    if (option.value === value) {
      close(true);
      return;
    }
    setFailure(null);
    if (option.requiresConfirmation) setCandidate(option.value);
    else change(option);
  }

  function menuKey(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close(true);
    } else if (event.key === "Tab" && !candidate) {
      close(true);
    } else if (
      !candidate &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      const rows = [
        ...panel.current.querySelectorAll('[role="menuitemradio"]'),
      ];
      const active = rows.indexOf(document.activeElement);
      const next =
        event.key === "Home"
          ? 0
          : event.key === "End"
            ? rows.length - 1
            : (active + (event.key === "ArrowDown" ? 1 : -1) + rows.length) %
              rows.length;
      rows[next]?.focus();
    }
  }

  if (!options.length) return null;
  const confirmation = permissionOption(capability, candidate);
  const retry =
    !failure?.unknown && permissionOption(capability, failure?.value);
  const label = capability.label || "权限";
  return (
    <span className="permission-control">
      <button
        type="button"
        ref={trigger}
        className={`permission-control-trigger${disabled ? " limited" : ""}`}
        aria-label={`${label}：${current?.label || "权限未确认"}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={reason || label}
        onClick={() => setOpen(!open)}
        onKeyDown={(event) => {
          if (["ArrowDown", "ArrowUp"].includes(event.key)) {
            event.preventDefault();
            setOpen(true);
          } else if (event.key === "Escape") close();
        }}
      >
        {pending ? (
          <CircleNotch size={15} className="spin" />
        ) : (
          <ShieldCheck size={15} />
        )}
        <span>{current?.label || "权限未确认"}</span>
        <CaretDown size={11} />
      </button>
      {active &&
        open &&
        createPortal(
          <div
            id={menuId}
            ref={panel}
            className="permission-menu"
            role={confirmation ? "dialog" : "menu"}
            aria-label={confirmation ? `确认使用${confirmation.label}` : label}
            aria-busy={pending || undefined}
            style={position || { visibility: "hidden" }}
            onKeyDown={menuKey}
          >
            {confirmation ? (
              <div className="permission-confirmation">
                <WarningCircle size={22} />
                <strong>允许更大的访问范围？</strong>
                <p>
                  {confirmation.description ||
                    `将使用“${confirmation.label}”。`}
                </p>
                <div className="permission-confirmation-actions">
                  <button
                    type="button"
                    data-permission-cancel
                    onClick={() => setCandidate(null)}
                  >
                    返回
                  </button>
                  <button
                    type="button"
                    className="permission-confirm"
                    disabled={blocked}
                    onClick={() => change(confirmation)}
                  >
                    {pending ? "确认中…" : "确认更改"}
                  </button>
                </div>
              </div>
            ) : (
              <>
                <div className="permission-menu-heading">
                  <span>{label}</span>
                  {capability.evidenceLabel && (
                    <small>{capability.evidenceLabel}</small>
                  )}
                </div>
                {options.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    role="menuitemradio"
                    aria-checked={option.value === value}
                    aria-disabled={blocked || undefined}
                    className={`permission-menu-option${option.requiresConfirmation ? " elevated" : ""}`}
                    onClick={() => choose(option)}
                  >
                    <span>
                      <strong>{option.label}</strong>
                      {option.description && (
                        <small>{option.description}</small>
                      )}
                    </span>
                    {option.value === value && (
                      <span className="permission-current">
                        <Check size={17} /> 当前
                      </span>
                    )}
                  </button>
                ))}
              </>
            )}
            {reason && (
              <p className="permission-menu-note" role="status">
                {reason}
              </p>
            )}
            {failure && (
              <div className="permission-menu-error" role="alert">
                <span>{failure.message}</span>
                {retry && (
                  <button
                    type="button"
                    disabled={blocked}
                    onClick={() => choose(retry)}
                  >
                    重试
                  </button>
                )}
              </div>
            )}
          </div>,
          document.body,
        )}
    </span>
  );
}
