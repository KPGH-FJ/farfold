import type { ReactNode } from "react";
import type { AgentCardModel, AuthMethodsResponse } from "../runtime/agents";
import type { ApiConfigurationState } from "../runtime/service_capability";
import type { AgentAccessPrimary } from "../runtime/access_primary";

export interface AgentConnectionPresentation {
  choice: "existing" | "login" | "api";
  stage: "method" | "account" | "api";
  apiAvailable: boolean;
  actionId?: string | null;
  onActionChange?: (id: string | null) => void;
  onChoice: (
    choice: "existing" | "login" | "api",
    methodId?: string,
    actionId?: string,
  ) => void;
  onStageChange: (stage: "method" | "account" | "api") => void;
  apiContent: ReactNode;
  apiSummary?: ReactNode;
  /** Live status of the saved-settings verification run by the setup host. */
  existingVerify?: {
    status: "connecting" | "ready" | "checking" | "failed";
    error?: string | null;
    onRetry?: () => void;
  };
  /** A confirmed authentication requirement applies to this target. */
  authRequired?: boolean;
  onUseExisting?: () => void;
  onPrimaryChange?: (action: AgentAccessPrimary | null) => void;
}

export interface AgentAuthSectionProps {
  agentId: string;
  cwd?: string | null;
  source?: string;
  apiState?: ApiConfigurationState;
  apiUnavailableReason?: string | null;
  methodId?: string | null;
  onMethodChange?: (methodId: string) => void;
  onConfigureKey: () => void;
  onChanged: () => Promise<void>;
  onReconnect: () => Promise<void>;
  onBusyChange?: (busy: boolean) => void;
  program?: string;
  onOpenModels?: () => void;
  canOpenModels?: boolean;
  onOpenConversation?: (threadKey: string) => void;
  active?: boolean;
  /** Presentation fields used for registration links and status text. */
  card?: Pick<
    AgentCardModel,
    "name" | "presentation" | "sourceUrl" | "installGuide"
  >;
  /** Establish the preparation connection before running a declaration. */
  onConnect?: () => Promise<void>;
  /** Reports the loaded declaration response; null while loading or failed. */
  onInfoChange?: (info: AuthMethodsResponse | null) => void;
  /** Program work in flight; account execution waits for it. */
  busy?: boolean;
  connection?: AgentConnectionPresentation;
}
