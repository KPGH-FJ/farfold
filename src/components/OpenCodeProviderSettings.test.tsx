import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OpenCodeProviderSettings } from "./OpenCodeProviderSettings";

describe("OpenCode Provider entry", () => {
  it("opens ACP directly on the managed connection form without legacy auth", () => {
    const html = renderToStaticMarkup(
      <OpenCodeProviderSettings
        running={false}
        taskLocked={false}
        canStart
        runtimeInstallationId="installation-qa"
        runtimeConnectionId="connection-qa"
        usesAcp
        onStart={async () => {}}
        onApply={async () => {}}
        onClose={() => {}}
      />,
    );
    expect(html).toContain("连接名称");
    expect(html).toContain("保存共享连接");
    expect(html).not.toContain("搜索模型服务");
    expect(html).not.toContain("API key 由 OpenCode 保存");
    expect(html).not.toContain("返回原生 Provider");
  });
});
