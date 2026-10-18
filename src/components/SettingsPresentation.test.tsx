import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeModelSettings } from "./LifeModelSettings";
import { GeneralSettingsDialog } from "./GeneralSettingsDialog";
afterEach(() => vi.unstubAllGlobals());

it("presents LifeModel as its current boundary without a future availability promise or live controls", () => {
  const html = renderToStaticMarkup(<LifeModelSettings />);
  expect(html).toContain("当前尚未启用");
  expect(html).toContain("产品说明");
  expect(html).toContain("未经批准的候选不能进入长期偏好");
  expect(html).not.toContain("即将推出");
  expect(html).not.toContain("button");
  expect(html).not.toContain("input");
});

it("describes separate data ownership and offers a scoped clear plus uninstall guidance", () => {
  const html = renderToStaticMarkup(
    <GeneralSettingsDialog page="privacy" onClose={() => {}} />,
  );
  expect(html).toContain("系统安全存储");
  expect(html).toContain("由你选择的 Agent 管理");
  expect(html).toContain("未发内容");
  // One scoped destructive action with its own confirmation, never a blanket wipe.
  expect(html).toContain("清除 Farfold 数据…");
  expect(html).not.toContain("清除全部");
  expect(html).not.toContain("将删除");
  expect(html).toContain("完整卸载 Farfold");
  expect(html).toContain("知道了");
});

it.each(["MacIntel", "Win32"])(
  "makes the actual %s shortcut details available independently from the compact summary",
  async (platform) => {
    vi.stubGlobal("navigator", { platform });
    vi.resetModules();
    const { GeneralSettingsDialog } = await import("./GeneralSettingsDialog");
    const mac = platform === "MacIntel";
    const html = renderToStaticMarkup(
      <GeneralSettingsDialog page="shortcuts" onClose={() => {}} />,
    );
    for (const shortcut of mac
      ? ["⌘ N", "⌘ K", "⌘ ,", "⌘ ⇧ P", "⇧ Enter", "Esc"]
      : ["Ctrl+N", "Ctrl+K", "Ctrl+,", "Ctrl+Shift+P", "Shift+Enter", "Esc"])
      expect(html).toContain(shortcut);
    expect(html).not.toContain(mac ? "Ctrl+" : "⌘");
    expect(html).toContain("关闭当前弹窗");
  },
);
