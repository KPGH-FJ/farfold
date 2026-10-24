import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, resolve, relative } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import ts from "typescript";

// Test-only boundary: no Agent, Tauri, dialogs, opener, network, or persistence.
const h = vi.hoisted(() => ({
  io: vi.fn(() => {
    throw new Error("Controlled state export rejects external IO");
  }),
  workError: false,
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.io, Channel: class {} }));
vi.mock("@tauri-apps/plugin-dialog", () => ({ open: h.io, save: h.io }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: h.io, openPath: h.io }));
vi.mock("../../../../../src/runtime/work_policy", () => ({
  useWorkPolicy: () => ({
    ready: !h.workError,
    saving: false,
    error: h.workError ? "Unable to read policy" : null,
    enabled: () => !h.workError,
    set: h.io,
    setLocation: h.io,
    retry: h.io,
  }),
}));
vi.mock("../../../../../src/runtime/draft_storage", async (original) => ({
  ...(await original<
    typeof import("../../../../../src/runtime/draft_storage")
  >()),
  useDraftSaveStatus: () => ({ ready: true, saving: false, error: null }),
}));
vi.mock("../../../../../src/runtime/performance-trace", () => ({
  traceAfterPaint() {},
}));

import { ThreadView } from "../../../../../src/components/ThreadView";
import { ElicitationCard } from "../../../../../src/components/ElicitationCard";
import { ApprovalCard } from "../../../../../src/components/thread-items";
import { Composer } from "../../../../../src/components/Composer";
import {
  FileArtifactView,
  FileDifference,
} from "../../../../../src/components/FileArtifactView";
import { MessageAttachments } from "../../../../../src/components/MessageContent";
import { freshThreadState } from "../../../../../src/runtime/session_projection";
import { composerDrafts } from "../../../../../src/runtime/drafts";
import {
  startQueueEditor,
  queueEditorKey,
} from "../../../../../src/runtime/queue_edit";
import { PNG_IMAGE_TEST_DATA } from "../../../../../src/runtime/image_fixtures.test-support";
import type { PendingElicitation } from "../../../../../src/runtime/session_types";
import type { FileArtifact } from "../../../../../src/runtime/artifact_view";

const ROOT = resolve("src");
const OUTPUT = resolve(
  "docs/evidence/2026-10-08-ui-coverage-audit/full-review/controlled-views/states",
);
const noop = () => {};
const digest = (s: string) => createHash("sha256").update(s).digest("hex");

// Same current-source dependency walk used by AgentSetup.r5-render.test.tsx.
// No custom CSS: the wrapper uses existing product container classes only.
function currentStyles() {
  const visited = new Set<string>();
  const cssPaths: string[] = [];
  const blocks: string[] = [];
  const require = createRequire(import.meta.url);
  function expand(path: string, ancestors = new Set<string>()): string {
    if (ancestors.has(path)) throw new Error("CSS cycle");
    if (!cssPaths.includes(path)) cssPaths.push(path);
    const next = new Set(ancestors).add(path);
    return readFileSync(path, "utf8").replace(
      /@import\s+(?:url\(\s*)?["']([^"']+)["']\s*\)?\s*([^;]*);/g,
      (_match, specifier: string, conditions: string) => {
        if (!specifier.startsWith(".") || conditions.trim())
          throw new Error("Unexpected CSS import");
        return expand(resolve(dirname(path), specifier), next);
      },
    );
  }
  function visit(path: string) {
    if (visited.has(path)) return;
    visited.add(path);
    const source = readFileSync(path, "utf8");
    if (path.endsWith(".css")) {
      blocks.push(expand(path));
      return;
    }
    const module = ts.createSourceFile(path, source, ts.ScriptTarget.Latest);
    module.forEachChild((node) => {
      if (
        !(ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) ||
        !node.moduleSpecifier ||
        !ts.isStringLiteral(node.moduleSpecifier)
      )
        return;
      const specifier = node.moduleSpecifier.text;
      if (!specifier.startsWith(".")) {
        if (specifier.endsWith(".css")) visit(require.resolve(specifier));
        return;
      }
      const target = resolve(dirname(path), specifier);
      if (specifier.endsWith(".css")) visit(target);
      else
        for (const ending of ["", ".tsx", ".ts"]) {
          if (existsSync(target + ending)) {
            visit(target + ending);
            break;
          }
        }
    });
  }
  visit(resolve(ROOT, "main.tsx"));
  return { css: blocks.join("\n"), paths: cssPaths, visited: [...visited] };
}
function shell(child: ReactNode) {
  return (
    <div className="app product-app">
      <div className="body-row">{child}</div>
    </div>
  );
}
function inTranscript(child: ReactNode) {
  return shell(
    <div className="thread-body conversation-workspace">
      <div className="thread-main">
        <div className="transcript">
          <div className="col">{child}</div>
        </div>
      </div>
    </div>,
  );
}
function threadView(thread: ReturnType<typeof freshThreadState>) {
  return shell(
    <ThreadView
      thread={thread}
      active
      agents={[]}
      onGoSettings={noop}
      onOpened={noop}
    />,
  );
}

it("exports six families of current components with existing fixture inputs and zero external IO", () => {
  vi.stubGlobal("fetch", h.io);
  const style = currentStyles();
  const files: Record<string, unknown>[] = [];
  mkdirSync(OUTPUT, { recursive: true });
  const save = (
    name: string,
    node: ReactNode,
    fixture: string[],
    scope: string,
    native = "",
  ) => {
    const markup = renderToStaticMarkup(node).replace(
      /src="(\/(?:agents|brand)\/[^\"]+)"/g,
      (_, path: string) =>
        `src="data:image/svg+xml;base64,${readFileSync(resolve("public" + path)).toString("base64")}"`,
    );
    const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; media-src data:; script-src 'unsafe-inline'"><title>${name} · 当前组件受控静态展示</title><style>${style.css}</style></head><body><div id="root">${markup}</div><script>${native}</script></body></html>`;
    writeFileSync(resolve(OUTPUT, name + ".html"), html);
    files.push({
      file: "states/" + name + ".html",
      fixture,
      scope,
      nativeDomSetup: native || null,
      sha256: digest(html),
      bytes: Buffer.byteLength(html),
      rendered: false,
    });
    expect(h.io).not.toHaveBeenCalled();
    return markup;
  };

  const options = [
    { optionId: "allow", kind: "allow_once", name: "Allow once" },
    { optionId: "reject", kind: "reject_once", name: "Reject" },
  ];
  const approvalProps = {
    title: "Run command",
    kind: "execute",
    locations: [],
    rawInput: {
      command: "touch '/tmp/approval file.txt' && printf '<review>'",
      cwd: "/tmp/execution folder",
    },
    options,
    onPick: noop,
  };
  for (const disabled of [false, true]) {
    const html = save(
      disabled ? "02-approval-stop-waiting" : "01-approval-pending",
      inTranscript(<ApprovalCard {...approvalProps} disabled={disabled} />),
      [
        "src/components/ApprovalInput.test.tsx:63",
        "src/components/ApprovalInput.test.tsx:86",
      ],
      disabled
        ? "审批卡停止等待时禁用；只展示单卡，不代表取消结果"
        : "审批卡完整命令/cwd与两个真实组件操作；合成请求，无执行",
    );
    expect(html).toContain("/tmp/execution folder");
  }
  const question: PendingElicitation = {
    requestId: "first",
    status: "pending",
    error: null,
    toolCallId: null,
    message: "First question",
    values: { answer: "first answer" },
    schema: {
      type: "object",
      properties: { answer: { type: "string" } },
      required: ["answer"],
    },
  };
  save(
    "03-question-pending",
    inTranscript(
      <ElicitationCard request={question} onChange={noop} onRespond={noop} />,
    ),
    ["src/components/ElicitationCard.test.tsx:6"],
    "现有单文本必填 schema 与已保存值；不覆盖数值/布尔/多选组合及提交",
  );
  save(
    "04-question-uncertain",
    inTranscript(
      <ElicitationCard
        request={{
          ...question,
          requestId: "second",
          message: "Second question",
          values: { answer: "second answer" },
          status: "uncertain",
          error: "回复结果未知",
        }}
        onChange={noop}
        onRespond={noop}
      />,
    ),
    ["src/components/ElicitationCard.test.tsx:6"],
    "未知回复只读表单，保留原值；没有真实回复请求",
  );

  const queue = freshThreadState(
    "controlled-queue",
    "a",
    "/p",
    "queue-fixture",
  );
  queue.identity = "established";
  queue.queuePaused = "stopped";
  queue.queued = [
    [{ type: "text", text: "original A" }],
    [{ type: "text", text: "original B" }],
  ];
  composerDrafts.update(`session:${queue.key}`, () => ({
    text: "draft remains",
    attachments: [],
  }));
  save(
    "05-queue-paused",
    threadView(queue),
    [
      "src/components/Composer.stop.test.tsx:243",
      "src/components/Composer.work.test.tsx:142",
    ],
    "现有两个待发文本合并到停止暂停样本；待发列表与继续入口，无发送",
  );
  startQueueEditor(queue.key, 0, queue.queued[0]);
  composerDrafts.update(queueEditorKey(queue.key), (d) => ({
    ...d,
    text: "edited A",
  }));
  save(
    "06-queue-editing",
    threadView(queue),
    ["src/components/Composer.work.test.tsx:142"],
    "真实队列编辑组件，由现有内存编辑器 fixture 打开；不保存/放弃/发送",
    "document.querySelectorAll('dialog').forEach(dialog=>dialog.showModal());",
  );
  composerDrafts.clear(queueEditorKey(queue.key));
  composerDrafts.clear(`session:${queue.key}`);

  const stop = freshThreadState("controlled-stop", "a", "/p", "stop-fixture");
  stop.stopUnconfirmed = true;
  stop.connectionOutcomeUnknown = true;
  const unknown = save(
    "07-stop-unknown",
    threadView(stop),
    ["src/components/Composer.stop.test.tsx:215"],
    "停止结果未知与重试入口；未发送取消或重试，不证明 Agent 已停止",
  );
  expect(unknown).toContain("c-stop-retry");
  h.workError = true;
  save(
    "08-work-read-error",
    inTranscript(
      <Composer
        thread={null}
        draftKey="controlled-work-error"
        workContext={{ agentId: "selected", cwd: "/notes" }}
        imageEnabled={false}
        disabled
        editableWhenDisabled
        onGoSettings={noop}
      />,
    ),
    ["src/components/Composer.work.test.tsx:102"],
    "现有 Unable to read policy 合成错误及重试入口；不是实际文件或设置失败",
  );
  h.workError = false;

  const card: FileArtifact = {
    kind: "diff",
    path: "snippet.ts",
    oldText: "old",
    newText: "new",
    scope: "fragment",
    source: "diff",
    status: "completed",
    time: 1,
  };
  save(
    "09-diff-fragment",
    inTranscript(<FileArtifactView card={card} threadKey="controlled-file" />),
    [
      "src/components/FileArtifactView.test.tsx:104",
      "src/components/FileArtifactView.test.tsx:119",
    ],
    "当前文件卡和片段统一差异；old/new 为已有 fixture，不代表磁盘状态",
  );
  save(
    "10-diff-split",
    inTranscript(<FileDifference card={card} split onLine={noop} />),
    ["src/components/FileArtifactView.test.tsx:119"],
    "当前分栏差异子组件及片段行号；不含完整文件面板、选行或意见操作",
  );
  const attachments = [
    {
      name: "图片",
      kind: "image" as const,
      data: PNG_IMAGE_TEST_DATA,
      mimeType: "image/png",
    },
    {
      name: "notes.md",
      kind: "resource" as const,
      uri: "file:///notes.md",
      text: "<script>not executable</script>",
    },
    {
      name: "unsupported",
      kind: "resource" as const,
      data: "eA==",
      mimeType: "text/html",
    },
  ];
  for (const expanded of [false, true]) {
    save(
      expanded ? "12-media-expanded" : "11-media-collapsed",
      inTranscript(<MessageAttachments attachments={attachments} />),
      [
        "src/components/MessageContent.test.tsx:68",
        "src/runtime/image_fixtures.test-support.ts:1",
      ],
      "结构化附件：现有有效 2×1 PNG 替换 markup 测试中的假图片字节，文本资源和不可预览资源；无音频/视频/PDF/Office实解码",
      expanded
        ? "document.querySelectorAll('details.message-attachment').forEach(detail=>detail.open=true);"
        : "",
    );
  }
  expect(files).toHaveLength(12);
  expect(h.io).not.toHaveBeenCalled();
  const inputs = [
    ...new Set([
      ...style.visited,
      ...style.paths,
      resolve("src/components/ApprovalInput.test.tsx"),
      resolve("src/components/ElicitationCard.test.tsx"),
      resolve("src/components/Composer.stop.test.tsx"),
      resolve("src/components/Composer.work.test.tsx"),
      resolve("src/components/FileArtifactView.test.tsx"),
      resolve("src/components/MessageContent.test.tsx"),
      resolve("src/runtime/image_fixtures.test-support.ts"),
    ]),
  ].map((path) => ({
    path: relative(resolve("."), path),
    sha256: digest(readFileSync(path, "utf8")),
  }));
  writeFileSync(
    resolve(OUTPUT, "manifest.json"),
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        classification: "当前源码生产组件受控静态展示，非安装版/非实际行为成功",
        files,
        sourceInputs: inputs,
        cssInputs: style.paths.map((path) => relative(resolve("."), path)),
        boundary:
          "仅SSR；生产组件无修改；当前全部CSS依赖原样内联；现有生产容器class提供孤立舞台，无自定义CSS。React事件未水合；只有声明的原生dialog/details打开。所有外部IO拒绝且未调用。",
      },
      null,
      2,
    ) + "\n",
  );
  vi.unstubAllGlobals();
});
