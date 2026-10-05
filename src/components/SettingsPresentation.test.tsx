import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LifeModelSettings } from "./LifeModelSettings";
import { GeneralSettingsDialog } from "./GeneralSettingsDialog";

it("presents LifeModel as its current boundary without a future availability promise or live controls", () => {
  const html = renderToStaticMarkup(<LifeModelSettings />);
  expect(html).toContain("当前尚未启用");
  expect(html).toContain("产品说明");
  expect(html).toContain("未经批准的候选不能进入长期偏好");
  expect(html).not.toContain("即将推出");
  expect(html).not.toContain("button");
  expect(html).not.toContain("input");
});

it("describes separate data ownership without providing a broad destructive operation", () => {
  const html = renderToStaticMarkup(
    <GeneralSettingsDialog page="privacy" onClose={() => {}} />,
  );
  expect(html).toContain("系统安全存储");
  expect(html).toContain("由你选择的 Agent 管理");
  expect(html).toContain("未发内容");
  expect(html).not.toContain("清除全部");
  expect(html).toContain("知道了");
});

it("makes the actual shortcut details available independently from the compact summary", () => {
  const html = renderToStaticMarkup(
    <GeneralSettingsDialog page="shortcuts" onClose={() => {}} />,
  );
  for (const shortcut of ["⌘ N", "⌘ K", "⌘ ,", "⌘ ⇧ P", "⇧ Enter", "Esc"])
    expect(html).toContain(shortcut);
  expect(html).toContain("关闭当前弹窗");
});
