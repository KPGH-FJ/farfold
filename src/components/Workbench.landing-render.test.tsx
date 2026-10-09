import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
  Channel: class {},
}));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    ready: true,
    cwd,
    enabled: () => false,
  }),
}));
vi.mock("../runtime/setup_storage", async (original) => ({
  ...(await original<typeof import("../runtime/setup_storage")>()),
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: {} }),
  },
}));
import { Sidebar } from "./Sidebar";
import { EmptyState } from "./EmptyState";
import { AgentHub } from "./AgentHub";
import { AgentDetails } from "./AgentDetails";
import { composerDrafts, newConversationChoice } from "../runtime/drafts";
import type { AgentCardModel, AgentsState } from "../runtime/agents";

const noop = () => {};
const card: AgentCardModel = {
  id: "preview-fixture",
  name: "预览 Agent",
  description: "受控排版样例，未连接真实服务。",
  status: "installed",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "discovered",
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};
const state = {
  cards: [card],
  connectedCards: [],
  loading: false,
  loadError: null,
  busy: {},
  scanning: false,
  installProgress: {},
  errors: {},
  install: noop,
  cancelInstall: noop,
  selectProgram: noop,
  selectInstallation: noop,
  refresh: noop,
  rescan: noop,
  connect: noop,
  reconnect: noop,
  remove: noop,
  addCustom: noop,
} as unknown as AgentsState;
function page(id: string, body: ReactNode) {
  const content = renderToStaticMarkup(body);
  expect(content, id).toContain("Agent");
}
function shell(content: ReactNode, active: "start" | "agents" = "start") {
  return (
    <div className="app product-app">
      <div className="body-row">
        <Sidebar
          agents={[card]}
          active={active}
          filter={{ kind: "all" }}
          currentKey={null}
          onNew={noop}
          onLibrary={noop}
          onOpenRow={noop}
          onSearch={noop}
          onSettings={noop}
          onExplore={noop}
          onAllAgents={noop}
          onCollapse={noop}
        />
        <div className="workspace-route">{content}</div>
      </div>
    </div>
  );
}
it("server-renders the workbench, discovery and unknown capabilities without rewriting historical evidence", () => {
  newConversationChoice.agentId = card.id;
  newConversationChoice.cwd = "/示例项目";
  newConversationChoice.service = null;
  newConversationChoice.config = {};
  composerDrafts.update("new", () => ({
    text: "请帮我整理这一周的项目进展，并指出还需要确认的事项。",
    attachments: [],
  }));
  page(
    "workbench",
    shell(
      <EmptyState
        agents={[card]}
        onGoSettings={noop}
        onProjectChange={noop}
        onStarted={noop}
        onRestoreDraft={async () => {}}
      />,
    ),
  );
  page(
    "agents",
    shell(
      <AgentHub
        agents={state}
        onReturn={noop}
        onStart={noop}
        onOpenApi={noop}
      />,
      "agents",
    ),
  );
  page(
    "capabilities",
    shell(
      <AgentDetails
        card={card}
        agents={state}
        active
        source="本机"
        onClose={noop}
        onPrepare={noop}
      />,
      "agents",
    ),
  );
  composerDrafts.clear("new");
});
