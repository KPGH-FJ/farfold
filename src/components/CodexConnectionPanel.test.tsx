import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { CodexConnectionPanel } from "./CodexConnectionPanel";
import type { CodexAcpScope } from "../runtime/codex-acp-contract";
const scope: CodexAcpScope = {
  runtimeProductId: "codex",
  installationId: "i",
  runtimeBuildId: "b",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "a",
  connectionId: "c",
  profileId: "p",
  generation: 1,
};
it("ordinary ACP account presentation stays closed even with a known scope", () => {
  const request = vi.fn();
  const html = renderToStaticMarkup(
    <CodexConnectionPanel
      acp={{
        scope,
        viewKey: "v",
        port: {
          allowed: false,
          current: () => true,
          request,
          discover: request,
        },
      }}
    />,
  );
  expect(html).toContain("ACP 认证入口暂未开放");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("<input");
  expect(html).not.toContain("https:");
  expect(request).not.toHaveBeenCalled();
});
it("mock account presentation reuses the panel without opening URLs or claiming readiness", () => {
  const html = renderToStaticMarkup(
    <CodexConnectionPanel
      acp={{
        scope,
        viewKey: "v",
        port: {
          allowed: true,
          current: () => true,
          request: vi.fn(),
          discover: vi.fn(),
        },
      }}
    />,
  );
  expect(html).toContain("ChatGPT 网页认证");
  expect(html).toContain("设备码认证");
  expect(html).not.toContain("<a ");
  expect(html).not.toContain("就绪");
});
