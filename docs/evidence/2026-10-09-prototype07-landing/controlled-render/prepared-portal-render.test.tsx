import { expect, it, vi } from "vitest";
import { Children, cloneElement, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { writeEvidencePage } from "./render-shell.mjs";
import type { ThreadState } from "../../../../src/runtime/session_types";
const h = vi.hoisted(() => ({
  thread: null as ThreadState | null,
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useSyncExternalStore: (_subscribe: unknown, read: () => unknown) => read(),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
vi.mock("../../../../src/runtime/sessions", async (original) => ({
  ...(await original<typeof import("../../../../src/runtime/sessions")>()),
  useThread: () => h.thread,
}));
vi.mock("../../../../src/runtime/work_policy", () => ({
  useWorkPolicy: (cwd: string | null) => ({
    ready: true,
    cwd,
    enabled: () => true,
  }),
}));
vi.mock("../../../../src/runtime/setup_storage", async (original) => ({
  ...(await original<typeof import("../../../../src/runtime/setup_storage")>()),
  useSetupStorage: () => ({}),
  setupStorage: {
    completed: () => true,
    confirmedSelection: () => ({ service: null, config: {} }),
  },
}));
import { EmptyState } from "../../../../src/components/EmptyState";
import { ThreadView } from "../../../../src/components/ThreadView";
import { Sidebar } from "../../../../src/components/Sidebar";
import { freshThreadState } from "../../../../src/runtime/session_projection";
import {
  composerDrafts,
  newConversationChoice,
} from "../../../../src/runtime/drafts";
import type { AgentCardModel } from "../../../../src/runtime/agents";
const noop = () => {};
const card: AgentCardModel = {
  id: "prepared-controlled",
  name: "受控 Agent",
  description: "准备后挂载布局检查",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "custom",
  installable: false,
  registerable: false,
  custom: true,
  handshake: { agentCapabilities: {} },
};
function find(
  node: ReactNode,
  predicate: (props: Record<string, unknown>) => boolean,
): ReactNode {
  for (const child of Children.toArray(node)) {
    if (!isValidElement<Record<string, unknown>>(child)) continue;
    if (predicate(child.props)) return child;
    const match = find(child.props.children as ReactNode, predicate);
    if (match) return match;
  }
  return null;
}
function populateHost(
  node: ReactNode,
  target: unknown,
  editor: ReactNode,
): ReactNode {
  return Children.map(node, (child) => {
    if (!isValidElement<Record<string, unknown>>(child)) return child;
    if (child.props.ref === target) return cloneElement(child, {}, editor);
    if (!child.props.children) return child;
    return cloneElement(
      child,
      {},
      populateHost(child.props.children as ReactNode, target, editor),
    );
  });
}
/** SSR cannot move a DOM node. Take the real EmptyState editor and insert it
 * at the actual ThreadView ref, preserving both production ancestor chains. */
function PreparedThread() {
  const target = { current: null };
  const empty = EmptyState({
    agents: [card],
    onGoSettings: noop,
    onProjectChange: noop,
    onStarted: noop,
    composerTarget: {} as HTMLElement,
  });
  const editor = find(empty, (props) => props.className === "empty-col");
  expect(editor).toBeTruthy();
  const view = ThreadView({
    thread: h.thread!,
    active: true,
    agents: [card],
    onGoSettings: noop,
    onOpened: noop,
    draftComposerRef: target,
    header: (
      <header className="workspace-topbar thread-topbar">
        <div className="thread-title">
          <h1>新会话 · 受控准备状态</h1>
          <span>受控位置 · 未在运行</span>
        </div>
      </header>
    ),
  });
  expect(find(view, (props) => props.ref === target)).toBeTruthy();
  return populateHost(view, target, editor);
}
it("renders the real prepared EmptyState editor inside the ThreadView host without running preparation or sending", () => {
  h.invoke.mockClear();
  const thread = freshThreadState(
    "prepared-controlled",
    card.id,
    "/受控工作文件夹",
    "controlled-id",
  );
  thread.identity = "draft";
  thread.configOptions = [
    {
      id: "model",
      name: "模型",
      category: "model",
      type: "select",
      currentValue: "model-a",
      options: [{ value: "model-a", name: "受控模型 A" }],
    },
    {
      id: "effort",
      name: "思考",
      category: "thought_level",
      type: "select",
      currentValue: "ultra",
      options: [{ value: "ultra", name: "Ultra" }],
    },
    {
      id: "permission",
      name: "权限",
      category: "permission",
      type: "select",
      currentValue: "ask",
      options: [{ value: "ask", name: "Approve for me" }],
    },
    {
      id: "extra",
      name: "附加设置",
      type: "boolean",
      currentValue: true,
      options: [],
    },
  ];
  thread.permissionConfigId = "permission";
  thread.permissionState = "ready";
  thread.configCheck = {
    status: "ready",
    issues: [],
    protectedIds: ["model", "effort"],
    current: { choices: [] },
  };
  h.thread = thread;
  newConversationChoice.agentId = card.id;
  newConversationChoice.cwd = thread.cwd;
  newConversationChoice.service = null;
  newConversationChoice.config = {};
  newConversationChoice.reviewRequired = false;
  composerDrafts.clear("new");
  const markup = renderToStaticMarkup(
    <div className="app product-app">
      <div className="body-row">
        <Sidebar
          agents={[card]}
          active="start"
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
        <div className="workspace-route">
          <main className="main workspace-thread">
            <PreparedThread />
          </main>
        </div>
      </div>
    </div>,
  );
  expect(markup).toContain("思考");
  expect(markup).toContain("Approve for me");
  expect(markup).toContain("更多设置");
  expect(markup.match(/class="composer fit/g)).toHaveLength(1);
  expect(h.invoke).not.toHaveBeenCalled();
  const html = writeEvidencePage(
    "conversation-07-prepared.html",
    "准备完成后的首发输入区",
    markup,
  );
  const directory = resolve(
    "docs/evidence/2026-10-09-prototype07-landing/controlled-render",
  );
  // Freeze the initial failing cascade before the production layout repair.
  const baseline = resolve(directory, "conversation-07-prepared-before.html");
  if (!existsSync(baseline)) {
    writeFileSync(
      resolve(directory, "prepared-portal-before.css"),
      readFileSync(resolve(directory, "production.css")),
    );
    writeFileSync(
      baseline,
      html.replace("./production.css", "./prepared-portal-before.css"),
    );
  }
});
