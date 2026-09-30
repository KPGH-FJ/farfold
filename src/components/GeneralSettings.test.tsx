import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GeneralSettings } from "./GeneralSettings";
import { STRINGS } from "../runtime/strings";
import type { ThemeMode } from "../runtime/theme";

vi.mock("../runtime/sessions", () => ({
  threads: {},
  useThreadsSnapshot: () => ({ index: [] }),
}));

it.each(["light", "dark", "system"] as const)(
  "preserves the selected %s theme in the three actual appearance choices",
  (themeMode: ThemeMode) => {
    const save = vi.fn();
    const html = renderToStaticMarkup(
      <GeneralSettings
        themeMode={themeMode}
        themeStatus={{
          ready: true,
          saving: false,
          error: null,
          retry: vi.fn(),
        }}
        onThemeMode={save}
      />,
    );
    expect(html.match(/class="general-theme-card"/g)).toHaveLength(3);
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(
        `aria-pressed="true"><span class="general-theme-swatch ${themeMode}"`,
      ),
    );
    expect(save).not.toHaveBeenCalled();
  },
);

it("only exposes supported settings and documents the actual keyboard actions", () => {
  const html = renderToStaticMarkup(
    <GeneralSettings
      themeMode="light"
      themeStatus={{ ready: false, saving: false, error: null, retry: vi.fn() }}
      onThemeMode={vi.fn()}
    />,
  );
  expect(html).not.toContain(STRINGS.general.proposal);
  expect(html).toContain("需要你时提醒");
  expect(html).toContain("提醒声音");
  expect(html.match(/尚未提供/g)).toHaveLength(2);
  expect(html).toContain("暂停消息发送");
  expect(html).toContain("查看快捷键");
  expect(html).toContain("你的数据如何保存");
  expect(html.indexOf("更新与诊断")).toBeLessThan(html.indexOf("暂停消息发送"));
  expect(html).not.toContain('role="switch"');
  expect(html).not.toContain("自定义");
  expect(html).toContain("⌘ ,");
  expect(html).not.toContain("零配置");
  expect(html).toContain("⌘ N");
  expect(html).toContain("⌘ K");
  expect(html).not.toContain("⇧ Enter");
  expect(
    html.match(/class="general-theme-card"[^>]*disabled=""/g),
  ).toHaveLength(3);
});
