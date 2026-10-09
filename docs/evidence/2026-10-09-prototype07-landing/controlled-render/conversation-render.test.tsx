import { expect, it, vi } from "vitest";
import {
  Children,
  isValidElement,
  type ReactNode,
  type ReactElement,
} from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { writeEvidencePage } from "./render-shell.mjs";
const h = vi.hoisted(() => ({
  capture: false,
  cursor: 0,
  slots: [] as { value: unknown }[],
  invoke: vi.fn().mockResolvedValue(null),
}));
vi.mock("react", async (original) => {
  const real = await original<typeof import("react")>();
  return {
    ...real,
    useState: (initial: unknown) => {
      if (!h.capture) return real.useState(initial);
      const slot = (h.slots[h.cursor++] ??= {
        value: typeof initial === "function" ? initial() : initial,
      });
      return [
        slot.value,
        (value: unknown) => {
          slot.value = typeof value === "function" ? value(slot.value) : value;
        },
      ];
    },
    useRef: (initial: unknown) =>
      h.capture
        ? (h.slots[h.cursor++] ??= { value: { current: initial } }).value
        : real.useRef(initial),
    useId: () => (h.capture ? `controlled-${h.cursor++}` : real.useId()),
    useEffect: (effect: () => void, deps?: unknown[]) => {
      if (!h.capture) real.useEffect(effect, deps);
    },
    useMemo: (read: () => unknown, deps: unknown[]) =>
      h.capture ? read() : real.useMemo(read, deps),
    useSyncExternalStore: (
      subscribe: (callback: () => void) => () => void,
      read: () => unknown,
      server?: () => unknown,
    ) =>
      h.capture ? read() : real.useSyncExternalStore(subscribe, read, server),
  };
});
vi.mock("../../../../src/runtime/work_policy", () => ({
  useWorkPolicy: () => ({ ready: true, enabled: () => true }),
}));
vi.mock("../../../../src/runtime/browser_surface", async (original) => ({
  ...(await original<
    typeof import("../../../../src/runtime/browser_surface")
  >()),
  useBrowserSurfaceBarrier: (requested: boolean) => requested,
}));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {},
}));
import {
  freshThreadState,
  applyUpdate,
  applyTurnEnd,
} from "../../../../src/runtime/session_projection";
import {
  composerDrafts,
  type DraftAttachment,
} from "../../../../src/runtime/drafts";
import type { AgentCardModel } from "../../../../src/runtime/agents";
import { ThreadView } from "../../../../src/components/ThreadView";
import { Composer } from "../../../../src/components/Composer";
import { ComposerAttachments } from "../../../../src/components/ComposerAttachments";
import { SessionOptionsList } from "../../../../src/components/SessionOptionsMenu";
import { ModelPicker } from "../../../../src/components/ModelPicker";
import { ConfigurationChangeReview } from "../../../../src/components/ConfigurationChangeReview";
import { MessageResendDialog } from "../../../../src/components/MessageResendDialog";
import { WorkspaceDialog } from "../../../../src/components/WorkspaceDialog";
import { WorkspaceActionMenu } from "../../../../src/components/WorkspaceActionMenu";

const noop = () => {};
const attachments: DraftAttachment[] = Array.from(
  { length: 8 },
  (_, index) => ({
    id: `controlled-file-${index}`,
    kind: "file",
    name:
      index === 0
        ? "关于工作台键盘导航、对比度与各页面操作一致性的完整检查记录.md"
        : index >= 6
          ? "修改意见.md"
          : `工作台设计-${index}.md`,
    uri: `file:///controlled-materials/第${index + 1}版/${index >= 6 ? "修改意见.md" : `工作台设计-${index}.md`}`,
  }),
);
const agent: AgentCardModel = {
  id: "controlled-agent",
  name: "受控 Agent",
  description: "仅供视觉检查的数据",
  status: "connected",
  version: null,
  authMethods: [],
  discoveredPath: null,
  registryVersion: null,
  source: null,
  installable: false,
  registerable: false,
  custom: true,
  handshake: {
    agentCapabilities: {
      promptCapabilities: { image: false, embeddedContext: true },
    },
  },
};
function state() {
  const thread = freshThreadState(
    "controlled-conversation",
    agent.id,
    "/controlled-materials/工作台改版",
    "controlled-id",
  );
  thread.identity = "established";
  thread.title = "工作台改版核对 · 受控内容";
  thread.configOptions = [
    {
      id: "model",
      name: "模型",
      category: "model",
      type: "select",
      currentValue: "controlled-model",
      options: [
        { value: "controlled-model", name: "受控模型 A" },
        { value: "controlled-alternative", name: "受控模型 B" },
      ],
    },
    {
      id: "effort",
      name: "思考深度",
      category: "thought_level",
      type: "select",
      currentValue: "medium",
      options: [
        { value: "low", name: "Low" },
        { value: "medium", name: "Medium" },
        { value: "high", name: "High" },
      ],
    },
    {
      id: "extra",
      name: "附加选项（受控名称）",
      category: "controlled-feature",
      type: "select",
      description: "这里使用受控数据检查完整说明、当前值和待确认选择的层级。",
      currentValue: "brief",
      options: [
        { value: "brief", name: "简洁说明" },
        { value: "detailed", name: "详细说明" },
      ],
    },
    {
      id: "unknown",
      name: "未识别选项（受控名称）",
      category: "controlled-feature",
      type: "future-type",
      currentValue: "current-only",
      options: [],
    },
  ];
  thread.configCheck = {
    status: "ready",
    issues: [],
    protectedIds: ["model", "effort"],
    current: { choices: [] },
  };
  thread.availableCommands = [
    {
      name: "review-project-accessibility-and-keyboard-navigation",
      description:
        "受控长说明：逐项检查工作台所有入口、键盘顺序、焦点返回、忙碌与未知状态，确保完整名称与说明在窄窗口中仍然可读。",
    },
    {
      name: "summarize-notes-with-original-source-locations",
      description: "受控说明：整理材料并保留来源位置。",
    },
    { name: "help", description: "受控简短说明" },
  ];
  thread.items = [
    {
      kind: "user",
      id: "controlled-user",
      text: "请检查这份工作台改版说明，重点看附件、输入区和设置比较。\n这段文字与全部结果均为受控呈现资料。",
      attachments: [],
      streaming: false,
      time: 0,
    },
    {
      kind: "agent",
      id: "controlled-answer",
      text: "已整理需要核对的三个部分：\n\n1. **附件**：收纳后仍能看到数量，展开后展示完整位置。\n2. **设置**：当前选择与准备更改的选择分开，确认后才提交。\n3. **消息**：编辑后追加为新消息，主输入草稿保持原样。\n\n以上是视觉检查使用的受控正文，不代表任何 Agent 已执行。",
      attachments: [],
      streaming: false,
      time: 0,
    },
  ];
  applyTurnEnd(thread, { stopReason: "end_turn" });
  return thread;
}
function app(content: ReactNode) {
  return (
    <div className="app product-app">
      <main className="main workspace-thread">{content}</main>
    </div>
  );
}
function conversation(content: ReactNode) {
  return app(
    <div className="thread-body conversation-workspace">{content}</div>,
  );
}
function capture(read: () => ReactNode) {
  h.capture = true;
  h.cursor = 0;
  try {
    return read();
  } finally {
    h.capture = false;
  }
}
function nodes(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  return Children.toArray(node).flatMap((child) =>
    isValidElement<Record<string, unknown>>(child)
      ? [child, ...nodes(child.props.children as ReactNode)]
      : [],
  );
}
function write(name: string, title: string, content: ReactNode) {
  const html = writeEvidencePage(name, title, renderToStaticMarkup(content));
  expect(html).toContain("受控数据");
  return html;
}

it("renders conversation, stop uncertainty, expanded attachments, configuration comparison, resend and command surfaces from formal components", () => {
  h.slots = [];
  h.invoke.mockClear();
  const thread = state();
  composerDrafts.update(`session:${thread.key}`, () => ({
    text: "这是尚未发送的受控草稿。关闭消息编辑窗后，这份文字与附件仍需保留。",
    attachments,
  }));
  const header = (
    <header className="workspace-topbar thread-topbar">
      <div className="thread-title">
        <h1>{thread.title}</h1>
        <span>工作台改版 · 受控位置</span>
      </div>
      <button className="btn btn-ghost">文件与输出</button>
    </header>
  );
  write(
    "conversation-01-thread.html",
    "对话与输入区",
    app(
      <ThreadView
        thread={thread}
        active
        agents={[agent]}
        onGoSettings={noop}
        onOpened={noop}
        onNewFromMessage={noop}
        header={header}
      />,
    ),
  );
  const stopping = state();
  stopping.stopUnconfirmed = true;
  stopping.running = true;
  stopping.pendingPermissions = [
    {
      requestId: "controlled-permission",
      status: "pending",
      error: null,
      title: "受控审批：查看指定文件",
      kind: "read",
      locations: [{ path: "/controlled-materials/检查记录.md" }],
      options: [
        { optionId: "once", name: "仅本次允许", kind: "allow_once" },
        { optionId: "reject", name: "拒绝", kind: "reject_once" },
      ],
    },
  ];
  write(
    "conversation-02-stop-unknown.html",
    "停止未确认与审批保护",
    app(
      <ThreadView
        thread={stopping}
        active
        agents={[agent]}
        onGoSettings={noop}
        onOpened={noop}
        header={header}
      />,
    ),
  );
  h.slots = [];
  const attachmentRead = () =>
    ComposerAttachments({ items: attachments, onRemove: noop });
  const toggle = nodes(capture(attachmentRead)).find(
    (node) => node.props["aria-expanded"] === false,
  )!;
  (toggle.props.onClick as () => void)();
  const expanded = capture(attachmentRead);
  write(
    "conversation-03-attachments-expanded.html",
    "完整附件位置与收纳",
    app(
      <section
        style={{
          maxWidth: 760,
          width: "100%",
          margin: "60px auto",
          padding: 20,
        }}
      >
        <h1 style={{ marginBottom: 20, fontSize: 24 }}>附件展开 · 受控状态</h1>
        <div className="composer-box">{expanded}</div>
      </section>,
    ),
  );
  h.slots = [];
  const optionRead = () => {
    const row = Children.toArray(
      SessionOptionsList({ thread, composer: true }).props.children,
    )[0] as ReactElement<Record<string, unknown>>;
    return (row.type as (props: unknown) => ReactNode)(row.props);
  };
  const picker = nodes(capture(optionRead)).find(
    (node) => node.type === ModelPicker,
  )!;
  (picker.props.onPick as (value: string) => void)("detailed");
  const comparison = capture(optionRead);
  write(
    "conversation-04-configuration.html",
    "设置说明与更改比较",
    conversation(
      <WorkspaceDialog title="对话设置 · 受控内容" onClose={noop}>
        <div className="conversation-message-editor">
          <dl className="workspace-identity">
            <dt>Agent</dt>
            <dd>受控 Agent</dd>
            <dt>服务</dt>
            <dd>沿用已有设置（受控来源）</dd>
          </dl>
          <ConfigurationChangeReview
            thread={thread}
            option={thread.configOptions[0]}
            value="controlled-alternative"
            onCancel={noop}
            onSaved={noop}
          />
          {comparison}
          <SessionOptionsList
            thread={{ ...thread, configOptions: [thread.configOptions[3]] }}
            composer
          />
        </div>
      </WorkspaceDialog>,
    ),
  );
  composerDrafts.update(`resend:${thread.key}`, () => ({
    text: "这是一份单独编辑的受控消息；确认后追加为新消息，原来的主输入草稿保持原样。",
    attachments: [attachments[0]],
  }));
  write(
    "conversation-05-resend.html",
    "独立消息编辑确认",
    conversation(
      <MessageResendDialog
        thread={thread}
        imageEnabled={false}
        embedContext
        continued
        onClose={noop}
        onGoSettings={noop}
      />,
    ),
  );
  h.slots = [];
  const composerRead = () =>
    Composer({
      thread,
      imageEnabled: false,
      onGoSettings: noop,
      autofocus: false,
    });
  const commandTrigger = nodes(capture(composerRead)).find(
    (node) => node.props["aria-label"] === "命令与模板",
  )!;
  (commandTrigger.props.onClick as () => void)();
  const commandMenu = nodes(capture(composerRead)).find(
    (node) => node.type === WorkspaceActionMenu,
  )!;
  write(
    "conversation-06-commands.html",
    "长命令与搜索面板",
    <>
      {app(null)}
      <section
        style={{
          position: "fixed",
          top: 84,
          left: "calc(50% - 240px)",
          maxWidth: "calc(100vw - 32px)",
        }}
      >
        <h1 style={{ fontSize: 22, marginBottom: 20 }}>命令面板 · 受控声明</h1>
        <div
          className="workspace-action-menu"
          style={{ position: "relative", maxHeight: "calc(100vh - 160px)" }}
        >
          {commandMenu.props.children as ReactNode}
        </div>
      </section>
    </>,
  );
  expect(
    h.invoke.mock.calls.some(
      ([name]) => name === "session_prompt" || name === "session_set_config",
    ),
  ).toBe(false);
});
