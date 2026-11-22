import { useEffect, useState } from "react";
import {
  ArrowLeftIcon,
  CompassIcon,
  GearIcon,
  KeyIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import type { AgentsState } from "../runtime/agents";
import type { ServiceEditRequest } from "../runtime/credentials";
import { STRINGS } from "../runtime/strings";
import type { ThemeMode, ThemeStatus } from "../runtime/theme";
import {
  GeneralSettings,
  type GeneralSettingsRequest,
} from "./GeneralSettings";
import { CredentialSettings } from "./CredentialSettings";
import { LifeModelSettings } from "./LifeModelSettings";
import "../settings-library-redesign.css";
import { ResumeDraftButton } from "./ResumeDraftButton";

export type SettingsTab = "keys" | "lifemodel" | "general";

const TABS = [
  { key: "general", label: STRINGS.settings.tabs.general, icon: GearIcon },
  { key: "keys", label: STRINGS.credentials.heading, icon: KeyIcon },
  {
    key: "lifemodel",
    label: STRINGS.settings.tabs.lifemodel,
    icon: SparkleIcon,
  },
  { key: "agents", label: STRINGS.settings.tabs.agents, icon: CompassIcon },
] as const;

interface SettingsPageProps {
  onReturn: () => void;
  onManageAgent: (agentId: string) => void;
  onOpenAgents: () => void;
  onResumeDraft?: () => void;
  onOpenConversation?: (key: string) => void;
  onOpenArchived?: () => void;
  active?: boolean;
  tab?: SettingsTab;
  editService?: ServiceEditRequest;
  generalRequest?: GeneralSettingsRequest | null;
  onGeneralRequestHandled?: () => void;
  onTabChange?: (tab: SettingsTab) => void;
  agents: AgentsState;
  initialCwd: string | null;
  initialTab?: SettingsTab;
  themeMode: ThemeMode;
  themeStatus: ThemeStatus;
  onThemeMode: (mode: ThemeMode) => void;
}

export function SettingsPage({
  agents,
  onReturn,
  onManageAgent,
  onOpenAgents,
  onResumeDraft,
  onOpenConversation,
  onOpenArchived,
  active = true,
  tab: selectedTab,
  editService,
  generalRequest,
  onGeneralRequestHandled,
  onTabChange,
  initialCwd,
  initialTab = "general",
  themeMode,
  themeStatus,
  onThemeMode,
}: SettingsPageProps) {
  const [localTab, setLocalTab] = useState<SettingsTab>(initialTab);
  const tab = selectedTab ?? localTab;
  const setTab = onTabChange ?? setLocalTab;
  const [keysVisited, setKeysVisited] = useState(tab === "keys");
  useEffect(() => {
    if (tab === "keys") setKeysVisited(true);
  }, [tab]);

  return (
    <main
      className="main settings-page settings-redesign-page"
      hidden={!active}
    >
      <div className="topbar settings-topbar">
        <div className="title">{STRINGS.settings.title}</div>
        <ResumeDraftButton onClick={onResumeDraft} />
      </div>
      <div className="settings-body">
        <nav className="s-nav" aria-label={STRINGS.settings.title}>
          {TABS.map((item) => (
            <button
              type="button"
              key={item.key}
              className={`sn ${tab === item.key ? "active" : ""}`}
              aria-pressed={tab === item.key}
              onClick={() =>
                item.key === "agents" ? onOpenAgents() : setTab(item.key)
              }
            >
              <item.icon size={17} />
              {item.label}
            </button>
          ))}
          <button
            type="button"
            className="sn settings-return"
            onClick={onReturn}
          >
            <ArrowLeftIcon size={14} />
            {STRINGS.settings.returnPage}
          </button>
        </nav>
        <div className="s-content">
          <div className="s-col">
            {(keysVisited || tab === "keys") && (
              <div hidden={!active || tab !== "keys"}>
                <CredentialSettings
                  cards={agents.cards}
                  active={active && tab === "keys"}
                  editService={editService}
                  onReturn={onReturn}
                />
              </div>
            )}
            {active && tab === "lifemodel" && <LifeModelSettings />}
            {active && tab === "general" && (
              <GeneralSettings
                request={generalRequest}
                onRequestHandled={onGeneralRequestHandled}
                onOpenConversation={onOpenConversation}
                onOpenArchived={onOpenArchived}
                onOpenAgents={(agentId) =>
                  agentId ? onManageAgent(agentId) : onOpenAgents()
                }
                agents={agents.cards}
                defaultCwd={initialCwd}
                themeMode={themeMode}
                themeStatus={themeStatus}
                onThemeMode={onThemeMode}
              />
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
