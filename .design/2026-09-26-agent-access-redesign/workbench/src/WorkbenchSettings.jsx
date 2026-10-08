import React from "react";
import {
  Gear,
  Key,
  Sparkle,
  Compass,
  ArrowRight,
  ArrowLeft,
} from "@phosphor-icons/react";
import Api from "./SettingsApi";
import Life from "./SettingsLife";
import General from "./SettingsGeneral";
export default function WorkbenchSettings({
  view,
  revision,
  settingsTab,
  setSettingsTab,
  openSettings,
  go,
  settingsOrigin,
  toast,
  tasks,
  agents,
  services,
  setServices,
  storageIssue,
  setModal,
  theme,
  setTheme,
  archiveDays,
  commitArchive,
  runArchive,
  setFilters,
}) {
  const EMPTY_FILTER = { agent: "", group: "", state: "all", query: "" };
  return (
    <div
      className="v2-settings"
      style={{ display: view === "settings" ? "flex" : "none" }}
      key={"settings-" + revision}
    >
      <nav aria-label="设置类别">
        {[
          ["general", "通用", Gear],
          ["api", "API 配置", Key],
          ["life", "LifeModel", Sparkle],
        ].map(([id, label, Icon]) => (
          <button
            key={id}
            className={settingsTab === id ? "selected" : ""}
            onClick={() => setSettingsTab(id)}
          >
            <Icon size={17} />
            {label}
          </button>
        ))}
        <button onClick={() => openSettings("agents")}>
          <Compass size={17} />
          Agent 与账号
          <ArrowRight size={14} />
        </button>
        <button
          className="v2-settings-back"
          onClick={() =>
            go(settingsOrigin, {
              preserveFilters: true,
              preservePreparation: true,
            })
          }
        >
          <ArrowLeft size={14} />
          返回刚才的页面
        </button>
      </nav>
      <div className="v2-settings-scroll">
        <div hidden={settingsTab !== "api"}>
          <Api
            toast={toast}
            tasks={tasks}
            agents={agents}
            services={services}
            onServicesChange={setServices}
          />
        </div>
        <div hidden={settingsTab !== "life"}>
          <Life toast={toast} />
        </div>
        <div hidden={settingsTab !== "general"}>
          <General
            toast={toast}
            storageIssue={storageIssue}
            onManageSending={() => setModal("work-policy")}
            theme={theme}
            setTheme={setTheme}
            tasks={tasks}
            archiveDays={archiveDays}
            onArchiveDaysChange={(value) => commitArchive(value, true)}
            onRunArchive={runArchive}
            onOpenArchived={() => {
              setFilters({ ...EMPTY_FILTER, state: "archived" });
              go("conversations", { preserveFilters: true });
            }}
          />
        </div>
      </div>
    </div>
  );
}
