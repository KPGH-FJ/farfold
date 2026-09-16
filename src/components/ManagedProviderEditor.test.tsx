import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ManagedProviderEditor } from "./ManagedProviderEditor";

describe("shared Provider editor", () => {
  it("presents explicit save and use commands without Runtime authentication callbacks", () => {
    const html = renderToStaticMarkup(
      <ManagedProviderEditor
        busy={false}
        taskLocked={false}
        saveLabel="保存共享连接"
        useSavedLabel="应用到新对话"
        onSave={async () => {}}
        onUseSaved={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("连接名称");
    expect(html).toContain("保存共享连接");
    expect(html).toContain("应用到新对话");
    expect(html).toContain('type="password"');
    expect(html).toContain('value="openai-chat-completions"');
    expect(html).toContain('value="openai-responses"');
    expect(html).not.toContain("OAuth");
    expect(html).not.toContain("保存并应用到 Pi");
  });

  it("preserves the legacy caller's save/apply labels and disables fields while task locked", () => {
    const html = renderToStaticMarkup(
      <ManagedProviderEditor
        busy={false}
        taskLocked
        saveLabel="保存并应用到 Pi"
        useSavedLabel="应用已保存连接"
        onSave={async () => {}}
        onUseSaved={async () => {}}
        onCancel={() => {}}
      />,
    );
    expect(html).toContain("保存并应用到 Pi");
    expect(html).toContain("应用已保存连接");
    expect(html).toContain('fieldset disabled=""');
    expect(html).not.toContain("应用到新对话");
  });
});
