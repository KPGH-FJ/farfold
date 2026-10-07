import type { ReactNode } from "react";
import type { AccountRegistrationProgress } from "../runtime/account_registration";
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
    status: "ready" | "checking" | "failed";
    error?: string | null;
    onRetry?: () => void;
  };
  onUseExisting?: () => void;
  onPrimaryChange?: (action: AgentAccessPrimary | null) => void;
}

export interface AgentAuthSectionProps {
  agentId: string;
  cwd?: string | null;
  source?: string;
  apiState?: ApiConfigurationState;
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
  focused?: boolean;
  active?: boolean;
  registration?: AccountRegistrationProgress;
  onRegistrationChange?: (
    value: AccountRegistrationProgress | undefined,
  ) => void;
  connection?: AgentConnectionPresentation;
}
