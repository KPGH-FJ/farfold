import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { expect, it } from "vitest";
import type { HostSessionBinding } from "../runtime/host-shadow";
import type { LifeModelWorkspace } from "../runtime/use-lifemodel-workspace";
import type { RuntimePanelProps } from "../runtime/workspace-contract";
import { MigratingRuntimePanel } from "./MigratingRuntimePanel";

const noop = () => undefined;
const unused = async (): Promise<never> => {
  throw new Error("LifeModel is outside this fixture");
};

const lifeModel: LifeModelWorkspace = {
  open: false,
  snapshot: null,
  candidates: [],
  selectedItemIds: [],
  unavailable: null,
  busy: false,
  onOpen: unused,
  onClose: noop,
  onReload: noop,
  onSources: noop,
  onSnapshot: noop,
  onCreate: unused,
  onUpdate: unused,
  onApprove: unused,
  onReject: unused,
  onDelete: unused,
  onWithdrawSource: unused,
  onPreviewLastSource: unused,
  onResolveLastSource: unused,
  onEnabled: unused,
  onSelectItem: noop,
  onClearSelection: noop,
};

function panelProps(
  overrides: Partial<RuntimePanelProps> = {},
): RuntimePanelProps {
  return {
    product: "pi",
    active: true,
    initialProjectPath: null,
    requestedHostSessionId: null,
    requestedHostSession: null,
    restoredHostSession: null,
    onRequestedHostSessionHandled: noop,
    onProjectPath: noop,
    onSelectRuntime: noop,
    themeMode: "light",
    onThemeMode: noop,
    onOpenUpdate: noop,
    lifeModel,
    notice: null,
    shellActions: { current: {} },
    onShellMeta: noop,
    ...overrides,
  };
}

function piSession(): HostSessionBinding {
  return {
    farfoldSessionId: "session-pi-1",
    runtimeProductId: "pi",
    installationId: "pi-installation",
    runtimeBuildId: "pi-build",
    adapterId: "pi-rpc",
    connectionId: "pi-connection",
    projectId: "project-1",
    projectPath: "/fixture/project",
    projectName: "project",
    workingCopyId: "wc-1",
    workingCopyPath: "/fixture/project",
    workingCopyKind: "root",
    branchName: null,
    nativeSessionId: "native-pi-1",
    nativeLocatorRegistered: true,
    title: "既有 Pi 会话",
    titleSource: "first_user",
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 2,
    lastOpenedAt: 3,
    unreviewedChangeCount: 0,
  };
}

function sourceFile() {
  return ts.createSourceFile(
    "MigratingRuntimePanel.tsx",
    readFileSync(
      new URL("./MigratingRuntimePanel.tsx", import.meta.url),
      "utf8",
    ),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
}

it("shows a truthful migration notice without promising capability", () => {
  const html = renderToStaticMarkup(
    <MigratingRuntimePanel {...panelProps()} />,
  );
  expect(html).toContain("工作台正在迁移");
  expect(html).toContain("新建、打开与发送暂不可用");
  expect(html).toContain("置顶、归档与删除仍可用");
});

function codexSession(): HostSessionBinding {
  return {
    ...piSession(),
    farfoldSessionId: "session-codex-1",
    runtimeProductId: "codex",
    adapterId: "codex-app-server",
    nativeSessionId: "native-codex-1",
    title: "既有 Codex 会话",
  };
}

it("shows the requested Session binding and keeps runtime switching", () => {
  const html = renderToStaticMarkup(
    <MigratingRuntimePanel
      {...panelProps({
        product: "codex",
        requestedHostSessionId: "session-codex-1",
        requestedHostSession: codexSession(),
      })}
    />,
  );
  expect(html).toContain("Codex 工作台正在迁移");
  expect(html).toContain("既有 Codex 会话");
  expect(html).toContain("待 Codex ACP 迁移完成后恢复打开");
  expect(html).toContain('value="pi"');
  expect(html).toContain('value="opencode"');
  expect(html).toContain('value="codex"');
});

it("never shows a requested Session belonging to another Runtime", () => {
  const html = renderToStaticMarkup(
    <MigratingRuntimePanel
      {...panelProps({
        product: "codex",
        requestedHostSessionId: "session-pi-1",
        requestedHostSession: piSession(),
      })}
    />,
  );
  expect(html).toContain("Codex 工作台正在迁移");
  expect(html).not.toContain("既有 Pi 会话");
});

it("shows the restored Session only when it belongs to this Runtime", () => {
  const own = renderToStaticMarkup(
    <MigratingRuntimePanel
      {...panelProps({ product: "pi", restoredHostSession: piSession() })}
    />,
  );
  expect(own).toContain("既有 Pi 会话");
  const foreign = renderToStaticMarkup(
    <MigratingRuntimePanel
      {...panelProps({ product: "codex", restoredHostSession: piSession() })}
    />,
  );
  expect(foreign).not.toContain("既有 Pi 会话");
});

it("renders nothing while another Runtime panel is active", () => {
  const html = renderToStaticMarkup(
    <MigratingRuntimePanel {...panelProps({ active: false })} />,
  );
  expect(html).toBe("");
});

it("consumes the requested Session only inside an explicit-deps effect", () => {
  const source = sourceFile();
  const effects: ts.CallExpression[] = [];
  function visit(node: ts.Node) {
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === "useEffect"
    )
      effects.push(node);
    ts.forEachChild(node, visit);
  }
  visit(source);
  const consume = effects.find((effect) =>
    effect.arguments[0]
      ?.getText(source)
      .includes("onRequestedHostSessionHandled"),
  );
  const report = effects.find((effect) =>
    effect.arguments[0]?.getText(source).includes("onShellMeta"),
  );
  expect(consume).toBeDefined();
  expect(report).toBeDefined();
  const consumeDeps = consume!.arguments[1]!.getText(source);
  expect(consumeDeps).toContain("ownedRequest");
  expect(consumeDeps).toContain("onRequestedHostSessionHandled");
  const reportDeps = report!.arguments[1]!.getText(source);
  expect(reportDeps).toContain("onShellMeta");
  expect(reportDeps).toContain("shownSessionKey");
});

it("performs no backend calls and never writes session focus", () => {
  const source = sourceFile();
  const calls: string[] = [];
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node)) calls.push(node.expression.getText(source));
    ts.forEachChild(node, visit);
  }
  visit(source);
  for (const forbidden of [
    "invoke",
    "focusHostSession",
    "openHostSession",
    "createHostSession",
    "useHostSessionDraft",
    "useSessionFocus",
  ]) {
    expect(calls).not.toContain(forbidden);
    expect(source.text).not.toContain(
      `from "../runtime/host-session-metadata"`,
    );
  }
});
