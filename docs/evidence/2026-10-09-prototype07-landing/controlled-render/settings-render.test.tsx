import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { writeEvidencePage } from "./render-shell.mjs";
import type { AgentCardModel } from "../../../../src/runtime/agents";
import type { SidebarRow } from "../../../../src/runtime/sidebar";

const h = vi.hoisted(() => ({
  states: new Map<number, unknown>(),
  cursor: 0,
  rows: [] as SidebarRow[],
  threads: new Map(),
  groups: [
    { id: "design", name: "产品设计" },
    { id: "research", name: "阅读与研究" },
  ],
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      const index = h.cursor++;
      return react.useState(
        h.states.has(index) ? h.states.get(index) : initial,
      );
    },
  };
});
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(() => {
    throw new Error("Controlled render must not call the desktop");
  }),
  Channel: class {},
}));
vi.mock("../../../../src/runtime/sessions", async () => ({
  ...(await import("../../../../src/runtime/sidebar")),
  threads: {
    subscribe: () => () => {},
    getSnapshot: () => ({
      index: h.rows.map((row) => ({ ...row, id: row.key })),
      threads: h.threads,
    }),
    archiveBlockReason: () => null,
  },
  useThreadsSnapshot: () => ({
    index: h.rows.map((row) => ({ ...row, id: row.key })),
    threads: h.threads,
  }),
}));
vi.mock("../../../../src/runtime/collections", async (original) => ({
  ...(await original<typeof import("../../../../src/runtime/collections")>()),
  useCollections: () => ({
    ready: true,
    saving: false,
    error: null,
    groups: h.groups,
    assignments: { one: "design", two: "research" },
  }),
  useLibraryRows: (archived = false) =>
    h.rows.filter((row) => row.archived === archived),
}));
vi.mock("../../../../src/runtime/auto_archive", async (original) => ({
  ...(await original<typeof import("../../../../src/runtime/auto_archive")>()),
  useAutoArchive: () => ({
    ready: true,
    running: false,
    count: 0,
    error: null,
  }),
}));
vi.mock("../../../../src/runtime/desktop_notifications", async (original) => ({
  ...(await original<
    typeof import("../../../../src/runtime/desktop_notifications")
  >()),
  useDesktopNotifications: () => ({
    ready: true,
    saving: false,
    enabled: false,
    sound: false,
    permission: "unknown",
    systemAlert: null,
    systemSound: null,
    clickRequiresRunning: false,
    error: null,
    submissionError: null,
    setEnabled: vi.fn(),
    setSound: vi.fn(),
    retry: vi.fn(),
  }),
}));
import { GeneralSettings } from "../../../../src/components/GeneralSettings";
import { GeneralSettingsDialog } from "../../../../src/components/GeneralSettingsDialog";
import { LifeModelSettings } from "../../../../src/components/LifeModelSettings";
import { ConversationLibrary } from "../../../../src/components/ConversationLibrary";
import { ImportConversations } from "../../../../src/components/ImportConversations";
import { MoveConversationsDialog } from "../../../../src/components/MoveConversationsDialog";
import { Sidebar } from "../../../../src/components/Sidebar";
import { freshThreadState } from "../../../../src/runtime/session_projection";

const noop = () => {};
const agents: AgentCardModel[] = ["Codex", "Pi", "OpenCode"].map((name) => ({
  id: name.toLowerCase(),
  name,
  description: "受控数据",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: true,
  registerable: true,
  custom: false,
  handshake: null,
}));
function markup(element: React.ReactNode, states: [number, unknown][] = []) {
  h.states = new Map(states);
  h.cursor = 0;
  const result = renderToStaticMarkup(element);
  h.states.clear();
  h.cursor = 0;
  return result;
}
function sidebar(active: "settings" | "library") {
  return markup(
    <Sidebar
      active={active}
      agents={agents}
      currentKey={null}
      filter={{ kind: "all" }}
      onNew={noop}
      onLibrary={noop}
      onOpenRow={noop}
      onSearch={noop}
      onSettings={noop}
      onExplore={noop}
      onAllAgents={noop}
      onCollapse={noop}
    />,
  );
}
function frame(body: string, active: "settings" | "library") {
  return `<div class="app product-app"><div class="body-row">${sidebar(active)}${body}</div></div>`;
}
function row(
  key: string,
  title: string,
  status: SidebarRow["status"] = "idle",
): SidebarRow {
  return {
    key,
    title,
    agentId: "codex",
    cwd: "/Users/example/Projects/farfold",
    nativeSessionId: key,
    pinned: key === "one",
    archived: false,
    updatedAt: 1791547200000,
    status,
    unread: key === "three",
    live: false,
    source: "meta",
  };
}

it("renders production settings, privacy, library and history using controlled state only", () => {
  h.rows = [
    row("one", "梳理首页的设计方案"),
    row("two", "阅读并整理研究资料", "run"),
    row("three", "核对本次修改", "need"),
  ];
  h.threads = new Map();
  const general = markup(
    <GeneralSettings
      themeMode="light"
      themeStatus={{ ready: true, saving: false, error: null, retry: noop }}
      onThemeMode={noop}
    />,
    [
      [0, "0.1.7"],
      [3, 30],
      [6, false],
    ],
  );
  const settings = `<main class="main settings-page settings-redesign-page"><div class="topbar settings-topbar"><div class="title">设置</div></div><div class="settings-body"><div class="s-content"><div class="s-col">${general}</div></div></div></main>`;
  const generalPage = writeEvidencePage(
    "settings-general.html",
    "通用设置与提醒",
    frame(settings, "settings"),
  );
  expect(generalPage).toContain("系统通知许可尚未确认");
  const privacy = markup(
    <GeneralSettingsDialog page="privacy" onClose={noop} />,
    [[0, "confirm"]],
  );
  const privacyPage = writeEvidencePage(
    "settings-privacy.html",
    "数据与隐私清除确认",
    privacy,
  );
  expect(privacyPage).toContain("我已了解清除范围");
  const life = markup(<LifeModelSettings />);
  writeEvidencePage(
    "settings-lifemodel.html",
    "LifeModel 当前边界",
    frame(
      `<main class="main settings-page settings-redesign-page"><div class="s-content"><div class="s-col">${life}</div></div></main>`,
      "settings",
    ),
  );
  const library = markup(
    <ConversationLibrary
      agents={agents}
      filter={{ kind: "all" }}
      onFilter={noop}
      onOpen={noop}
      onImport={noop}
      onNew={noop}
      defaultCwd={null}
    />,
  );
  writeEvidencePage(
    "settings-library.html",
    "对话库",
    frame(library, "library"),
  );
  const moving = markup(
    <MoveConversationsDialog
      count={1}
      rows={[{ title: "梳理首页的设计方案", groupId: "design" }]}
      groups={h.groups}
      busy={false}
      error={null}
      onMove={noop}
      onClose={noop}
    />,
    [[0, "research"]],
  );
  const movingPage = writeEvidencePage(
    "settings-move.html",
    "移动到分组确认",
    moving,
  );
  expect(movingPage).toContain("确认移动");
  const discovered = [
    {
      nativeSessionId: "history-one",
      cwd: "/Users/example/Projects/farfold",
      title: "梳理首页的设计方案",
      updatedAt: null,
      canLoad: true,
      locationAvailable: true,
      alreadyAddedId: null,
      isOpen: false,
    },
    {
      nativeSessionId: "history-two",
      cwd: "/Users/example/Notes",
      title: "阅读并整理研究资料",
      updatedAt: null,
      canLoad: false,
      locationAvailable: true,
      alreadyAddedId: null,
      isOpen: false,
    },
  ];
  const state = freshThreadState(
    "preview",
    "codex",
    discovered[0].cwd,
    "history-one",
  );
  state.items = [
    {
      kind: "user",
      id: "user",
      text: "请整理这次页面改版需要先解决的问题。",
      attachments: [],
      streaming: false,
      time: 1,
    },
    {
      kind: "agent",
      id: "reply",
      text: "先核对主要操作和状态反馈，再处理布局、文字与键盘操作。这里的内容用于展示真实组件的排版。",
      streaming: false,
      time: 2,
    },
  ];
  const preview = {
    agentId: "codex",
    cwd: discovered[0].cwd,
    nativeSessionId: "history-one",
    previewToken: "controlled-preview",
    replayComplete: true,
    state,
  };
  const history = markup(
    <ImportConversations
      agents={agents}
      open
      defaultCwd={null}
      onClose={noop}
      onOpen={noop}
    />,
    [
      [3, discovered],
      [4, "next-page"],
      [5, true],
      [6, false],
      [9, new Set(["history-one"])],
      [10, preview],
      [11, "history-one"],
    ],
  );
  const historyPage = writeEvidencePage(
    "settings-history.html",
    "带入已有对话",
    history,
  );
  expect(historyPage).toContain("重新检查这段对话");
  expect(historyPage).toContain("正文");
});
