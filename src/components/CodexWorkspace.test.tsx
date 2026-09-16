import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { CodexWorkspace } from "./CodexWorkspace";
import type { LifeModelWorkspace } from "../runtime/use-lifemodel-workspace";

it("ordinary unbound workspace reuses one shell and cannot create or authenticate ACP", () => {
  const noop = () => undefined;
  const unused = async () => {
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
  const html = renderToStaticMarkup(
    <CodexWorkspace
      active
      initialProjectPath="/fixture"
      requestedHostSessionId={null}
      requestedHostSession={null}
      onRequestedHostSessionHandled={noop}
      onProjectPath={noop}
      onSelectRuntime={noop}
      onSelectHostSession={noop}
      themeMode="light"
      onThemeMode={noop}
      onOpenUpdate={noop}
      lifeModel={lifeModel}
      notice={null}
      hostChannel={{
        state: null,
        unavailable: false,
        reconnectForQa: async () => {
          throw new Error("not used");
        },
      }}
    />,
  );
  expect(html.match(/class="app-shell"/g)).toHaveLength(1);
  expect(html).toContain("新建 Codex ACP 会话");
  expect(html).toContain("既有旧会话仍按原绑定打开");
  expect(html).toMatch(/<button disabled="">程序与账号设置<\/button>/);
  expect(html).toMatch(/class="start-primary" disabled="">ACP 入口暂未开放/);
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain("读取模型目录");
  expect(html).not.toContain("连接已就绪");
});
