import { useConnectionAccount } from "../runtime/connection_account";
import type { AccountIdentity } from "../runtime/agents";

const labels: Record<AccountIdentity["kind"], string> = {
  account: "账号登录",
  api_key: "API 密钥",
  gateway: "自定义模型服务",
  external: "其他认证方式",
  none: "未登录",
  credential: "已检测到登录资料",
  missing_credential: "未检测到登录资料",
  not_required: "当前服务不要求登录",
};

/** Common account presentation; a connection report never proves request availability. */
export function ConnectionAccount({
  agentId,
  cwd,
  source,
  active,
  connectionId,
}: {
  agentId: string;
  cwd: string | null;
  source?: string;
  active: boolean;
  connectionId?: string;
}) {
  const account = useConnectionAccount(
    agentId,
    cwd,
    source,
    active,
    connectionId,
  );
  if (source || !account) return null;
  return (
    <div
      className="journey-connection-summary connection-account-summary"
      aria-label="当前账号"
    >
      <strong>{labels[account.kind]}</strong>
      {account.email && <span>{account.email}</span>}
      {account.displayName && <span>{account.displayName}</span>}
      {account.plan && <span>{`账号方案：${account.plan}`}</span>}
      <span className="auth-note">
        {["credential", "missing_credential", "not_required"].includes(
          account.kind,
        )
          ? "由 Agent 检查本地设置；尚未验证服务是否可用。"
          : "由 Agent 报告；实际服务与模型以当前选择为准。"}
      </span>
    </div>
  );
}
