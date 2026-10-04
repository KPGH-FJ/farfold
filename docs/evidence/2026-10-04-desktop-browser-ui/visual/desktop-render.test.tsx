import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { Sidebar } from "/Users/tw/Desktop/farfold/src/components/Sidebar";
import { ThreadView } from "/Users/tw/Desktop/farfold/src/components/ThreadView";
import { composerDrafts } from "/Users/tw/Desktop/farfold/src/runtime/drafts";
import { freshThreadState } from "/Users/tw/Desktop/farfold/src/runtime/session_projection";
import {
  GlobeIcon,
  SidebarSimpleIcon,
  ArrowLeftIcon,
  MagnifyingGlassIcon,
  FilesIcon,
} from "@phosphor-icons/react";

const h = vi.hoisted(() => ({
  pending: false,
  externalIo: vi.fn(() => {
    throw new Error("Visual fixture rejects external IO");
  }),
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.externalIo,
  Channel: class {},
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.externalIo }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.externalIo }));
vi.mock("/Users/tw/Desktop/farfold/src/runtime/performance-trace", () => ({
  traceAfterPaint: () => {},
}));
vi.mock("/Users/tw/Desktop/farfold/src/runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock(
  "/Users/tw/Desktop/farfold/src/runtime/collections",
  async (original) => ({
    ...(await original<
      typeof import("/Users/tw/Desktop/farfold/src/runtime/collections")
    >()),
    useCollections: () => ({
      ready: true,
      saving: false,
      error: null,
      groups: [],
      assignments: {},
    }),
    useLibraryRows: () => [],
  }),
);
vi.mock(
  "/Users/tw/Desktop/farfold/src/runtime/draft_storage",
  async (original) => ({
    ...(await original<
      typeof import("/Users/tw/Desktop/farfold/src/runtime/draft_storage")
    >()),
    useDraftSaveStatus: () => ({ ready: true, saving: false, error: null }),
  }),
);
vi.mock(
  "/Users/tw/Desktop/farfold/src/runtime/browser_sharing",
  async (original) => ({
    ...(await original<
      typeof import("/Users/tw/Desktop/farfold/src/runtime/browser_sharing")
    >()),
    useBrowserSharing: () => ({
      info: null,
      ready: true,
      operation: null,
      error: "",
      notice: "",
      pendingRequest: h.pending
        ? {
            requestId: "visual-page-request",
            taskKey: "visual-thread",
            label: "visual-page",
            url: "https://example.org/research/reading-plan",
            pageRevision: 1,
            phase: "awaiting_permission",
          }
        : null,
      refresh: h.externalIo,
      allow: h.externalIo,
      stop: h.externalIo,
      respond: h.externalIo,
    }),
  }),
);

const source = "/Users/tw/Desktop/farfold";
const output = resolve("output");
const styles = [
  "styles.css",
  "styles-settings.css",
  "styles-content.css",
  "styles-thread.css",
  "styles-artifact.css",
  "product-shell.css",
  "conversation-workspace.css",
  "history-import.css",
  "new-conversation-pickers.css",
  "message-attachments.css",
  "browser-workspace.css",
  "desktop-workbench.css",
];
const inputs = [
  ...styles.map((name) => `src/${name}`),
  ...[
    "Sidebar",
    "ThreadView",
    "Composer",
    "BrowserReadRequest",
    "BrowserShareControls",
    "BrowserWorkspace",
    "ArtifactPane",
  ].map((name) => `src/components/${name}.tsx`),
];
const hashes = Object.fromEntries(
  inputs.map((path) => [
    path,
    createHash("sha256")
      .update(readFileSync(resolve(source, path)))
      .digest("hex"),
  ]),
);
const css = styles
  .map((name) => readFileSync(resolve(source, "src", name), "utf8"))
  .join("\n");
const noAction = () => {};
const key = "session:visual-thread";
const agent = {
  id: "registry:opencode",
  name: "OpenCode",
  description: "合成展示条目",
  status: "connected" as const,
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: "registry",
  installable: false,
  registerable: false,
  custom: false,
  handshake: null,
};
afterEach(() => {
  composerDrafts.clear(key);
  vi.clearAllMocks();
});

it.each([
  {
    name: "01-request-light",
    theme: "light",
    pending: true,
    browser: false,
    running: true,
  },
  {
    name: "02-request-dark",
    theme: "dark",
    pending: true,
    browser: false,
    running: true,
  },
  {
    name: "03-browser-light",
    theme: "light",
    pending: false,
    browser: true,
    running: false,
  },
  {
    name: "04-browser-dark",
    theme: "dark",
    pending: false,
    browser: true,
    running: false,
  },
  {
    name: "05-conversation-light",
    theme: "light",
    pending: false,
    browser: false,
    running: false,
  },
  {
    name: "07-browser-pending-dark",
    theme: "dark",
    pending: true,
    browser: true,
    running: true,
  },
])("exports production components without external IO: $name", (scenario) => {
  h.pending = scenario.pending;
  const thread = freshThreadState(
    "visual-thread",
    agent.id,
    "/fixture/research",
    "visual-session",
  );
  thread.identity = "established";
  thread.running = scenario.running;
  thread.artifactPaneOpen = scenario.browser;
  thread.configOptions = [
    {
      id: "model",
      name: "模型",
      category: "model",
      type: "select",
      currentValue: "example",
      options: [{ value: "example", name: "示例模型" }],
    },
    {
      id: "reasoning",
      name: "思考",
      category: "thought_level",
      type: "select",
      currentValue: "normal",
      options: [{ value: "normal", name: "标准" }],
    },
  ];
  thread.items = [
    {
      kind: "user",
      id: "user-1",
      text: "请整理当前网页的三个要点，并标明出处。",
      attachments: [],
      streaming: false,
      time: 1,
    },
    ...(scenario.pending
      ? []
      : [
          {
            kind: "agent" as const,
            id: "assistant-1",
            text: "这是一段用于核对排版的合成回复。\n\n1. 先确定资料来源与目标。\n2. 保留需要核对的信息。\n3. 将确认后的结果整理为文件。\n\n**接下来可以继续补充材料。**",
            streaming: false,
            time: 2,
          },
        ]),
  ];
  composerDrafts.update(key, () => ({
    text: "请保留原有出处，并列出需要继续核对的问题。",
    attachments: [],
  }));
  const markup = renderToStaticMarkup(
    <div className="app product-app">
      <div className="body-row">
        <Sidebar
          agents={[agent]}
          active="thread"
          filter={{ kind: "all" }}
          onNew={noAction}
          onLibrary={noAction}
          onSearch={noAction}
          onSettings={noAction}
          onExplore={noAction}
          onCollapse={noAction}
        />
        <div className="workspace-route">
          <main className="main workspace-thread">
            <ThreadView
              thread={thread}
              active
              agents={[agent]}
              onGoSettings={noAction}
              onOpened={noAction}
              contentMode="browser"
              onContentModeChange={noAction}
              header={
                <header className="workspace-topbar thread-topbar">
                  <button className="icon-button" aria-label="返回">
                    <ArrowLeftIcon size={19} />
                  </button>
                  <div className="thread-title">
                    <h1>网页资料整理</h1>
                    <span>合成展示 · 不连接 Agent</span>
                  </div>
                  <button className="icon-button" aria-label="查找">
                    <MagnifyingGlassIcon size={19} />
                  </button>
                  <button className="btn btn-ghost" aria-label="内容">
                    <FilesIcon size={18} />
                    <span>内容</span>
                  </button>
                  <button className="icon-button" aria-label="浏览器">
                    <GlobeIcon size={18} />
                  </button>
                </header>
              }
            />
          </main>
        </div>
      </div>
    </div>,
  ).replace(/src="(\/(?:brand|agents)\/[^\"]+)"/g, (_, path: string) => {
    const bytes = readFileSync(resolve(source, `public${path}`));
    return `src="data:image/svg+xml;base64,${bytes.toString("base64")}"`;
  });
  expect(h.externalIo).not.toHaveBeenCalled();
  expect(markup).toContain("composer-box");
  expect(markup).toContain("OpenCode");
  if (scenario.pending) expect(markup).toContain("允许读取并继续");
  if (scenario.browser)
    expect(markup).toContain("browser-workspace-address-row");
  mkdirSync(output, { recursive: true });
  writeFileSync(
    resolve(output, `${scenario.name}.html`),
    `<!doctype html><html lang="zh-CN" data-theme="${scenario.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'"><title>生产组件受控视觉：${scenario.name}</title><style>${css}</style></head><body><div id="root">${markup}</div></body></html>`,
  );
  writeFileSync(
    resolve(output, "source-hashes.json"),
    JSON.stringify(
      {
        inputs: hashes,
        externalIo: 0,
        scope:
          "Static React render of real production Sidebar/ThreadView/Composer/ArtifactPane/BrowserWorkspace/BrowserReadRequest; synthetic props and metadata only; header fixture uses existing App selectors; no effects, models or installed app. Browser state is initial empty state, not a live page.",
      },
      null,
      2,
    ),
  );
});
