import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserWorkspace } from "./BrowserWorkspace";
import { createBrowserWorkspaceClient } from "../runtime/browser_workspace";

it("offers an accessible tab list and explicit new-page action", () => {
  const client = createBrowserWorkspaceClient(vi.fn(), vi.fn(), vi.fn());
  const html = renderToStaticMarkup(
    <BrowserWorkspace taskKey="task-a" active client={client} />,
  );
  expect(html).toContain('role="tablist"');
  expect(html).toContain('aria-label="网页标签"');
  expect(html).toContain('aria-label="新建网页"');
});

it("bridges explicit page selection independently of page navigation", async () => {
  const invoke = vi.fn(async () => ({}));
  const client = createBrowserWorkspaceClient(
    invoke as any,
    vi.fn(),
    vi.fn(),
  ) as any;
  expect(typeof client.select).toBe("function");
  await client.select({
    taskKey: "task-a",
    label: "page-b",
    expectedSelected: { label: "page-a", revision: 2 },
  });
  expect(invoke).toHaveBeenCalledExactlyOnceWith("browser_workspace_select", {
    taskKey: "task-a",
    label: "page-b",
    expectedSelected: { label: "page-a", revision: 2 },
  });
});
