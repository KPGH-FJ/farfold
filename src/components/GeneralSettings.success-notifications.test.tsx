import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const h = vi.hoisted(() => ({
  enabled: false,
  successEnabled: true,
  saving: false,
}));
vi.mock("../runtime/sessions", () => ({
  threads: {},
  useThreadsSnapshot: () => ({ index: [] }),
}));
vi.mock("../runtime/desktop_notifications", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../runtime/desktop_notifications")>();
  return {
    ...actual,
    useDesktopNotifications: () => ({
      ...h,
      ready: true,
      error: null,
      submissionError: null,
      sound: false,
      permission: "authorized",
      systemAlert: false,
      systemSound: true,
      clickRequiresRunning: false,
      setEnabled: vi.fn(),
      setSuccessEnabled: vi.fn(),
      setSound: vi.fn(),
      retry: vi.fn(),
    }),
  };
});
import { GeneralSettings } from "./GeneralSettings";
function render() {
  return renderToStaticMarkup(
    <GeneralSettings
      themeMode="light"
      themeStatus={{ ready: true, saving: false, error: null, retry: vi.fn() }}
      onThemeMode={vi.fn()}
    />,
  );
}
it("presents attention and success as independent labelled switches, sharing system facts and sound", () => {
  const html = render();
  expect(html).toMatch(/aria-label="需要你时提醒" aria-checked="false"/);
  expect(html).toMatch(/aria-label="工作完成时提醒" aria-checked="true"/);
  expect(html.match(/role="switch"/g)).toHaveLength(3);
  expect(html).toContain("系统横幅已关闭");
  expect(html).toContain("没有待确认步骤");
  expect(html).toContain("不会自动连接或发送消息");
});
it("keeps all three choices disabled during a pending preference save", () => {
  h.saving = true;
  try {
    expect(render().match(/role="switch"[^>]*disabled=""/g)).toHaveLength(3);
  } finally {
    h.saving = false;
  }
});
