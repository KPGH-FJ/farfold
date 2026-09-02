import { ShieldWarning } from "@phosphor-icons/react";
import type { OpenCodePermissionRequest } from "../runtime/opencode-conversation";

interface OpenCodePermissionCardProps {
  request: OpenCodePermissionRequest;
  busy: boolean;
  onRespond: (response: "once" | "always" | "reject") => void;
}

export function OpenCodePermissionCard({
  request,
  busy,
  onRespond,
}: OpenCodePermissionCardProps) {
  const detail = request.patterns.length
    ? request.patterns.join(" · ")
    : JSON.stringify(request.metadata);
  return (
    <section className="runtime-permission" aria-labelledby="permission-title">
      <ShieldWarning size={19} weight="fill" aria-hidden="true" />
      <div>
        <p className="runtime-permission-eyebrow">OpenCode 原生权限请求</p>
        <h3 id="permission-title">允许 {request.permission}？</h3>
        <p>{detail || "OpenCode 未提供额外说明。"}</p>
        <small>
          此选择只回复 OpenCode 的原生权限请求，不会创建 LifeModel Proposal。
        </small>
      </div>
      <div className="runtime-permission-actions">
        <button disabled={busy} onClick={() => onRespond("reject")}>
          拒绝
        </button>
        <button disabled={busy} onClick={() => onRespond("always")}>
          始终允许
        </button>
        <button
          className="runtime-permission-primary"
          disabled={busy}
          onClick={() => onRespond("once")}
        >
          仅本次允许
        </button>
      </div>
    </section>
  );
}
