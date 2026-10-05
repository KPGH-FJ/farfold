import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Composer } from "./Composer";
import { Sidebar } from "./Sidebar";
import { AgentLogo } from "./AgentLogo";
import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { composerDrafts } from "../runtime/drafts";
import { freshThreadState } from "../runtime/session_projection";

const h = vi.hoisted(() => ({
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
vi.mock("../runtime/performance-trace", () => ({ traceAfterPaint: () => {} }));
vi.mock("../runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock("../runtime/collections", async (original) => ({
  ...(await original<typeof import("../runtime/collections")>()),
  useCollections: () => ({
    ready: true,
    saving: false,
    error: null,
    groups: [],
    assignments: {},
  }),
  useLibraryRows: () => [],
}));
vi.mock("../runtime/draft_storage", async (original) => ({
  ...(await original<typeof import("../runtime/draft_storage")>()),
  useDraftSaveStatus: () => ({ ready: true, saving: false, error: null }),
}));

const output = "/tmp/farfold-brand-composer-controlled-2026-10-03";
const sourceFiles = [
  "src/styles.css",
  "src/styles-settings.css",
  "src/styles-thread.css",
  "src/product-shell.css",
  "src/conversation-workspace.css",
  "src/new-conversation-pickers.css",
];
const css = sourceFiles
  .map((file) => readFileSync(resolve(file), "utf8"))
  .join("\n");
const noAction = () => {};
const draftKey = "brand-composer-visual-fixture";
afterEach(() => {
  composerDrafts.clear(draftKey);
  vi.clearAllMocks();
});

it.each([
  { name: "01-start-light", theme: "light", start: true, running: false },
  { name: "02-start-dark", theme: "dark", start: true, running: false },
  { name: "03-thread-light", theme: "light", start: false, running: false },
  { name: "04-thread-dark", theme: "dark", start: false, running: false },
  { name: "05-running-light", theme: "light", start: false, running: true },
])(
  "exports the real sidebar and Composer without any execution ($name)",
  (scenario) => {
    const thread = freshThreadState(
      "visual-thread",
      "fixture-agent",
      "/fixture",
      "fixture-session",
    );
    thread.identity = "established";
    thread.running = scenario.running;
    const input = {
      text: scenario.start
        ? ""
        : "请整理这份计划中的待办事项，先列出需要确认的问题。",
      attachments: scenario.start
        ? []
        : [
            {
              id: "fixture-note",
              kind: "file" as const,
              name: "项目计划.md",
              uri: "file:///fixture/plan.md",
            },
          ],
    };
    composerDrafts.update(draftKey, () => input);
    const markup = renderToStaticMarkup(
      <div className="visual-shell">
        <Sidebar
          agents={[]}
          active={scenario.start ? "start" : "thread"}
          filter={{ kind: "all" }}
          onNew={noAction}
          onLibrary={noAction}
          onSearch={noAction}
          onSettings={noAction}
          onExplore={noAction}
          onCollapse={noAction}
        />
        <main
          className={
            scenario.start
              ? "workspace-start visual-main"
              : "conversation-workspace visual-main"
          }
        >
          <div className="visual-composer-column">
            <div className="workspace-start-intro">
              <h1>{scenario.start ? "想从哪里开始？" : "项目计划"}</h1>
            </div>
            {scenario.start && (
              <div className="workspace-folder-bar">
                <span className="workspace-folder-label">工作文件夹</span>
                <button className="workspace-folder-button">
                  <FolderSimpleIcon size={18} />
                  <span>选择工作文件夹</span>
                  <CaretDownIcon size={12} />
                </button>
              </div>
            )}
            <Composer
              thread={scenario.start ? null : thread}
              imageEnabled={false}
              onGoSettings={noAction}
              draftKey={draftKey}
              autofocus={false}
              fit={scenario.start}
              placeholder="输入消息，或添加文件开始工作…"
              controls={
                <>
                  <button className="new-choice-trigger">
                    <span className="workspace-agent-label">
                      <AgentLogo
                        card={{
                          id: "registry:opencode",
                          name: "OpenCode",
                          description: "",
                          status: "connected",
                          version: null,
                          authMethods: [],
                          discoveredPath: null,
                          registryVersion: null,
                          source: "registry",
                          installable: false,
                          registerable: false,
                          custom: false,
                          handshake: null,
                        }}
                      />
                      <span>OpenCode</span>
                    </span>
                    <CaretDownIcon size={10} />
                  </button>
                  <span className="workspace-control-divider" />
                  <button className="new-choice-trigger workspace-model-control">
                    <span className="workspace-model-label">示例模型</span>
                    <CaretDownIcon size={10} />
                  </button>
                  <label className="composer-reasoning">
                    思考
                    <select defaultValue="标准">
                      <option>标准</option>
                    </select>
                  </label>
                </>
              }
              caption="受控展示 · 不连接 Agent"
            />
          </div>
        </main>
      </div>,
    ).replace(/src="(\/(?:brand|agents)\/[^\"]+)"/g, (_, path: string) => {
      const bytes = readFileSync(resolve(`public${path}`));
      return `src="data:image/svg+xml;base64,${bytes.toString("base64")}"`;
    });
    expect(h.externalIo).not.toHaveBeenCalled();
    expect(composerDrafts.read(draftKey)).toEqual(input);
    expect(markup).toContain('role="img" aria-label="Farfold"');
    expect(markup).toContain('class="brand-light"');
    expect(markup).toContain('class="brand-dark"');
    if (scenario.running) expect(markup).toContain('class="c-stop"');
    mkdirSync(output, { recursive: true });
    writeFileSync(
      resolve(output, `${scenario.name}.html`),
      `<!doctype html><html lang="zh-CN" data-theme="${scenario.theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>${css}\n.visual-shell{display:flex;min-height:100vh}.visual-main{flex:1;min-width:0;display:flex;align-items:center;justify-content:center;padding:40px 28px}.visual-composer-column{width:830px;max-width:100%}.visual-composer-column>.composer{max-width:100%;padding-inline:0}.visual-shell .product-sidebar{min-height:100vh}</style></head><body>${markup}</body></html>`,
    );
  },
);
