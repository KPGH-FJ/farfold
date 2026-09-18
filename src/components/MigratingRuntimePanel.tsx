import { ArrowsLeftRight } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { HostSessionBinding } from "../runtime/host-shadow";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import type { RuntimeProduct } from "./RuntimeChooser";

const RUNTIME_LABELS: Record<RuntimeProduct, string> = {
  pi: "Pi",
  opencode: "OpenCode",
  codex: "Codex",
};

const RUNTIME_ORDER: readonly RuntimeProduct[] = ["pi", "opencode", "codex"];

// Placeholder for Runtimes whose workspace has not completed the ACP
// migration. It performs no backend calls and never opens a native Session:
// the shared shell hands over the requested Host Session binding only when it
// belongs to this panel's Runtime, and record management (pin/archive/delete)
// stays on the shared Sidebar. Session focus is deliberately not written —
// the Session was never opened here.
export function MigratingRuntimePanel({
  product,
  active,
  requestedHostSession,
  restoredHostSession,
  onRequestedHostSessionHandled,
  onSelectRuntime,
  onShellMeta,
}: RuntimePanelProps) {
  const [remembered, setRemembered] = useState<HostSessionBinding | null>(null);
  // Never adopt a binding belonging to another Runtime, even if a caller
  // bypasses the shell's product-scoped request routing.
  const ownedRequest =
    requestedHostSession?.runtimeProductId === product
      ? requestedHostSession
      : null;
  const restoredForProduct =
    restoredHostSession?.runtimeProductId === product
      ? restoredHostSession
      : null;
  const shownSession = ownedRequest ?? remembered ?? restoredForProduct;

  useEffect(() => {
    if (!ownedRequest) return;
    setRemembered(ownedRequest);
    onRequestedHostSessionHandled(ownedRequest.farfoldSessionId);
  }, [ownedRequest, onRequestedHostSessionHandled]);

  const shownSessionKey = shownSession?.farfoldSessionId ?? null;
  useEffect(() => {
    onShellMeta({
      activeSessionKey: shownSessionKey,
      busy: false,
      working: false,
      providerCount: 0,
      contextOpen: false,
    });
  }, [onShellMeta, shownSessionKey]);

  if (!active) return null;

  const label = RUNTIME_LABELS[product];
  return (
    <section className="migrating-panel" aria-label={`${label} 工作台迁移中`}>
      <div className="start-state">
        <h2>{label} 工作台正在迁移</h2>
        <p>
          该 Runtime 正在迁移到统一 ACP 工作台。历史 Session
          记录保留在侧栏，置顶、归档与删除仍可用；新建、打开与发送暂不可用。
        </p>
        <div className="runtime-chooser migrating-runtime-chooser">
          <label>
            <ArrowsLeftRight size={13} aria-hidden="true" />
            <span className="sr-only">Agent Runtime</span>
            <select
              value={product}
              onChange={(event) => {
                const selected = event.target.value;
                if (
                  selected === "pi" ||
                  selected === "opencode" ||
                  selected === "codex"
                )
                  onSelectRuntime(selected);
              }}
              aria-label="选择 Agent Runtime"
            >
              {RUNTIME_ORDER.map((option) => (
                <option key={option} value={option}>
                  {RUNTIME_LABELS[option]}
                </option>
              ))}
            </select>
          </label>
        </div>
        {shownSession && (
          <p className="migrating-session">
            会话「{shownSession.title}」（{shownSession.projectName}
            ）记录已保留，待 {label} ACP 迁移完成后恢复打开。
          </p>
        )}
      </div>
    </section>
  );
}
