import { useEffect, useRef, useState } from "react";
import { permissionChangeState, permissionOption } from "./permission-state.js";

// Local review timer only. Production must await the Agent's returned value.
export default function useConversationPermission(
  task,
  capability,
  onTaskChange,
  context,
) {
  const current = useRef(null);
  current.current = { task, capability, onTaskChange, context };
  const job = useRef(null);
  const [readError, setReadError] = useState("");
  useEffect(
    () => () => {
      if (!job.current) return;
      clearTimeout(job.current.timer);
      job.current.reject(
        Object.assign(new Error("结果未确认"), { code: "permission_unknown" }),
      );
      job.current = null;
    },
    [],
  );

  const apply = (value, reading = false) => {
    const owner = current.current;
    const base = reading
      ? { ...owner.task, permissionChange: null }
      : owner.task;
    const gate = permissionChangeState(base, owner.context);
    if (job.current || gate.disabled)
      return Promise.reject(new Error(gate.reason || "请稍候"));
    if (!permissionOption(owner.capability, value))
      return Promise.reject(new Error("此权限选项不可用"));
    const id = crypto.randomUUID();
    owner.onTaskChange({
      permissionChange: {
        id,
        phase: "pending",
        requestedValue: value,
        reading,
      },
      ...(owner.task.queue?.length ? { queuePaused: true } : {}),
    });
    return new Promise((resolve, reject) => {
      job.current = {
        reject,
        timer: setTimeout(() => {
          job.current = null;
          const latest = current.current;
          if (latest.task.permissionChange?.id !== id) {
            reject(
              Object.assign(new Error("结果未确认"), {
                code: "permission_unknown",
              }),
            );
            return;
          }
          const unavailable = permissionChangeState(
            { ...latest.task, permissionChange: null },
            latest.context,
          ).disabled;
          const outcome = latest.task.permissionPreviewResult || "success";
          if (
            unavailable ||
            outcome === "unknown" ||
            (reading && outcome === "failed")
          ) {
            latest.onTaskChange({
              permissionChange: { id, phase: "unknown", requestedValue: value },
            });
            reject(
              Object.assign(new Error("权限更改结果未确认，请先重新读取。"), {
                code: "permission_unknown",
              }),
            );
          } else if (outcome === "failed") {
            latest.onTaskChange({ permissionChange: null });
            reject(new Error("Agent 未接受这次权限变更。"));
          } else {
            latest.onTaskChange({
              permissionValue: value,
              permissionCapability: structuredClone(latest.capability),
              permissionChange: null,
            });
            resolve(value);
          }
        }, 650),
      };
    });
  };
  const read = async () => {
    setReadError("");
    try {
      // Review fixture represents an eventual read returning the requested value.
      await apply(current.current.task.permissionChange?.requestedValue, true);
    } catch (error) {
      setReadError(error.message || "尚未读取到权限，请重试。");
    }
  };
  return { change: apply, read, readError };
}
