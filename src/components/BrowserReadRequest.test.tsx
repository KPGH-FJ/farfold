import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { BrowserReadRequest } from "./BrowserReadRequest";
import type { BrowserSharingModel } from "../runtime/browser_sharing";

function model(patch: Partial<BrowserSharingModel> = {}): BrowserSharingModel {
  return {
    info: null,
    ready: true,
    queryState: "ready",
    operation: null,
    error: "",
    notice: "",
    pendingRequest: {
      requestId: "request-a",
      taskKey: "task-a",
      label: "page-a",
      url: "https://example.org/research",
      pageRevision: 2,
      phase: "awaiting_permission",
    },
    refresh: vi.fn(async () => {}),
    allow: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    respond: vi.fn(async () => {}),
    ...patch,
  };
}
function findButton(
  tree: unknown,
  text: string,
): ReactElement<{ children: string; onClick(): void }> {
  const node = tree as ReactElement<{
    children?: unknown;
    onClick(): void;
  }> | null;
  if (node?.type === "button" && node.props.children === text)
    return node as ReturnType<typeof findButton>;
  for (const child of [node?.props?.children].flat(Infinity)) {
    if (!child || typeof child !== "object") continue;
    try {
      return findButton(child, text);
    } catch {
      /* Search siblings. */
    }
  }
  throw new Error("Missing button");
}

it("shows the exact page and read-only scope without fabricated page text or response", () => {
  const html = renderToStaticMarkup(<BrowserReadRequest sharing={model()} />);
  expect(html).toContain("https://example.org/research");
  expect(html).toContain("标题、地址和文字");
  expect(html).toContain("不会点击或填写");
  expect(html).toContain("允许读取并继续");
  expect(html).not.toContain("模拟");
});

it("responds to the same request and never calls the manual grant or whole-sharing stop", () => {
  const sharing = model();
  const tree = BrowserReadRequest({ sharing });
  findButton(tree, "允许读取并继续").props.onClick();
  expect(sharing.respond).toHaveBeenCalledWith("request-a", true);
  findButton(tree, "取消本次读取").props.onClick();
  expect(sharing.respond).toHaveBeenCalledWith("request-a", false);
  expect(sharing.allow).not.toHaveBeenCalled();
  expect(sharing.stop).not.toHaveBeenCalled();
});

it("removes expired permission buttons and keeps confirmed resolution compact", () => {
  const html = renderToStaticMarkup(
    <BrowserReadRequest
      sharing={model({ pendingRequest: null, notice: "已允许读取本页。" })}
    />,
  );
  expect(html).toContain('role="status"');
  expect(html).not.toContain("<button");
  expect(
    renderToStaticMarkup(
      <BrowserReadRequest sharing={model({ pendingRequest: null })} />,
    ),
  ).toBe("");
});

it("shows a status recovery action without reviving an ended request", () => {
  const html = renderToStaticMarkup(
    <BrowserReadRequest
      sharing={model({
        pendingRequest: null,
        notice: "已允许读取本页。",
        error: "未能确认本次操作，请重新检查读取请求。",
      })}
    />,
  );
  expect(html).toContain("重新检查");
  expect(html).not.toContain("允许读取并继续");
  expect(html).not.toContain("已允许读取本页");
});

it("locates the page without responding or sending a message", () => {
  const sharing = model();
  const onViewPage = vi.fn();
  findButton(
    BrowserReadRequest({ sharing, onViewPage }),
    "查看网页",
  ).props.onClick();
  expect(onViewPage).toHaveBeenCalledOnce();
  expect(sharing.respond).not.toHaveBeenCalled();
});

it("keeps an unconfirmed request visible with a status retry and disables decisions", () => {
  const sharing = model({
    ready: false,
    queryState: "failed",
    error: "未能确认本次操作，请重新检查读取请求。",
  });
  const html = renderToStaticMarkup(<BrowserReadRequest sharing={sharing} />);
  expect(html).toContain("https://example.org/research");
  expect(html).toMatch(/disabled=""[^>]*>允许读取并继续/);
  expect(html).toMatch(/disabled=""[^>]*>取消本次读取/);
  findButton(BrowserReadRequest({ sharing }), "重新检查").props.onClick();
  expect(sharing.refresh).toHaveBeenCalledTimes(1);
  expect(sharing.respond).not.toHaveBeenCalled();
});

it("shows exact one-shot input content as inert text and approves only that pending request", () => {
  const sharing = model();
  sharing.pendingRequest = {
    ...sharing.pendingRequest!,
    control: {
      kind: "input",
      target: "Search",
      text: "<script>private draft</script>",
    },
  };
  const html = renderToStaticMarkup(<BrowserReadRequest sharing={sharing} />);
  expect(html).toContain("需要填写网页内容");
  expect(html).toContain("仅允许这一次操作");
  expect(html).toContain("&lt;script&gt;private draft&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("允许读取并继续");
  findButton(BrowserReadRequest({ sharing }), "允许本次操作").props.onClick();
  expect(sharing.respond).toHaveBeenCalledWith("request-a", true);
  expect(sharing.allow).not.toHaveBeenCalled();
});

it("keeps screenshot consent distinct from text reading", () => {
  const sharing = model();
  sharing.pendingRequest = {
    ...sharing.pendingRequest!,
    control: { kind: "screenshot", target: "当前网页可见区域" },
  };
  const html = renderToStaticMarkup(<BrowserReadRequest sharing={sharing} />);
  expect(html).toContain("需要截取当前网页");
  expect(html).toContain("可见区域的截图");
  expect(html).toContain("允许本次操作");
});
