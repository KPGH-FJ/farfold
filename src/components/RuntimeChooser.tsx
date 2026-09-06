import { useEffect, useState } from "react";
import { ArrowsLeftRight } from "@phosphor-icons/react";
import {
  inspectRuntimeCapabilities,
  runtimeCapabilityRows,
  type RuntimeAuthoritySnapshot,
} from "../runtime/runtime-capability";

export type RuntimeProduct = "pi" | "opencode";

interface RuntimeChooserProps {
  value: RuntimeProduct;
  disabled: boolean;
  running: boolean;
  providerStatus: string;
  lifeModelEnabled: boolean;
  onChange: (runtime: RuntimeProduct) => void;
}

export function RuntimeChooser({
  value,
  disabled,
  running,
  providerStatus,
  lifeModelEnabled,
  onChange,
}: RuntimeChooserProps) {
  const [snapshot, setSnapshot] = useState<RuntimeAuthoritySnapshot | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    void inspectRuntimeCapabilities(value)
      .then((result) => {
        if (!cancelled) setSnapshot(result);
      })
      .catch((reason) => {
        if (!cancelled) setError(String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [value, running, lifeModelEnabled]);
  const current = snapshot?.runtime.productId === value ? snapshot : null;
  const rows = runtimeCapabilityRows(current);
  return (
    <div className="runtime-chooser">
      <label>
        <ArrowsLeftRight size={13} aria-hidden="true" />
        <span className="sr-only">Agent Runtime</span>
        <select
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value as RuntimeProduct)}
          aria-label="选择 Agent Runtime"
        >
          <option value="pi">Pi</option>
          <option value="opencode">OpenCode</option>
        </select>
      </label>
      <div
        className="runtime-capabilities"
        role="status"
        aria-label="Runtime 状态"
      >
        {error ? (
          <span className="unverified" title={error}>
            运行组件检查失败
          </span>
        ) : (
          rows.map((row) => <span key={row}>{row}</span>)
        )}
        <span>{running ? "进程已运行" : "进程未运行"}</span>
        <span>模型请求：{providerStatus}</span>
        <span>LifeModel：{lifeModelEnabled ? "已启用" : "已关闭"}</span>
      </div>
    </div>
  );
}
