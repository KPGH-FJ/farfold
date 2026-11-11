import {
  Children,
  isValidElement,
  type ReactElement,
  type ReactNode,
} from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  SessionToolConfigurationView,
  SessionToolsDialog,
  SessionToolsReportView,
  SessionToolStartupView,
} from "./SessionToolsDialog";
import {
  capability,
  deferred,
  failed,
  fixture,
  flush,
  pending,
  ready,
} from "../runtime/session_tools.test-support";
import { SESSION_TOOLS_STRINGS as S } from "../runtime/session_tools_strings";
import type { SessionToolsReport } from "../runtime/session_tools_types";

const getController = vi.hoisted(() => vi.fn());
const hooks = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[] }));
vi.mock("../runtime/session_tools_controller", async (original) => ({
  ...(await original<typeof import("../runtime/session_tools_controller")>()),
  getSessionToolsController: getController,
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useEffect: () => {},
  useMemo: (compute: () => unknown) => compute(),
  useRef: (current: unknown) => ({ current }),
  useState: (initial: () => unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values[index] = initial();
    return [
      hooks.values[index],
      (next: unknown) => (hooks.values[index] = next),
    ];
  },
  useSyncExternalStore: (_subscribe: unknown, get: () => unknown) => get(),
}));

beforeEach(() => {
  hooks.values = [];
});

function renderDialog(h: ReturnType<typeof fixture>) {
  hooks.cursor = 0;
  return SessionToolsDialog({
    thread: h.owner,
    title: "Owned report",
    active: true,
    onClose: vi.fn(),
  });
}

type DialogNode = ReactElement<{
  children?: ReactNode;
  className?: string;
  role?: string;
  "aria-atomic"?: string;
  onClick?(): void;
  onChange?(event: { target: { value: string } }): void;
}>;
function nodes(children: ReactNode): DialogNode[] {
  return Children.toArray(children).filter((node): node is DialogNode =>
    isValidElement(node),
  );
}
function descendants(children: ReactNode): DialogNode[] {
  return nodes(children).flatMap((node) => [
    node,
    ...descendants(node.props.children),
  ]);
}
function activateRead(h: ReturnType<typeof fixture>) {
  const footer = nodes(renderDialog(h).props.children as ReactNode).find(
    (node) => node.type === "footer",
  );
  nodes(footer?.props.children)[1].props.onClick!();
}
function announcement(tree: ReturnType<typeof renderDialog>, expected: string) {
  const children = tree.props.children as ReactNode;
  const status = nodes(children).find((node) => node.props.role === "status");
  expect(status).toBeDefined();
  expect(status?.props["aria-atomic"]).toBe("true");
  expect(
    descendants(children).filter((node) => node.props.role === "status"),
  ).toEqual([status]);
  expect(Children.toArray(status?.props.children).join("")).toBe(expected);
  return status;
}

it("mounts an empty report announcement outside the busy content even with an earlier receipt", async () => {
  const h = fixture();
  getController.mockReturnValue(h.controller);
  h.owner.sessionToolInventory = {
    ...capability,
    startup: {
      reportedCount: 1,
      loadedCount: 1,
      failedCount: 0,
      unknownCount: 0,
    },
  };
  h.controller.read();
  await flush();
  h.read.resolve(ready(h.request()));
  await flush();
  const tree = renderDialog(h);
  expect(h.controller.getSnapshot().lastReport?.value.reportedItemCount).toBe(
    1,
  );
  announcement(tree, "");
});

it("keeps the keyboard action mounted and focusable during read, check, and receipt", async () => {
  const h = fixture();
  h.owner.sessionToolInventory = {
    ...capability,
    configuration: true,
    toolsUnavailable: true,
  };
  getController.mockReturnValue(h.controller);
  const action = (label: string) => {
    const tree = renderDialog(h);
    const footer = Children.toArray(tree.props.children as ReactNode).find(
      (node) => isValidElement(node) && node.type === "footer",
    );
    if (!isValidElement<{ children: ReactNode }>(footer))
      throw new Error("Missing report footer");
    const button = Children.toArray(footer.props.children)[1];
    if (
      !isValidElement<{
        children: ReactNode;
        disabled?: boolean;
        "aria-disabled"?: boolean;
        onClick(): void;
      }>(button)
    )
      throw new Error("Missing keyboard action");
    expect(button.props.children).toBe(label);
    return button;
  };
  const initialStatus = announcement(renderDialog(h), "");
  const original = action(S.read);
  const remainsFocusable = (label: string, waiting: boolean) => {
    const button = action(label);
    expect([button.type, button.key]).toEqual([original.type, original.key]);
    expect(button.props.disabled).not.toBe(true);
    expect(button.props["aria-disabled"] === true).toBe(waiting);
    return button;
  };

  original.props.onClick();
  original.props.onClick();
  await flush();
  const readingStatus = announcement(renderDialog(h), S.loading);
  expect([readingStatus?.type, readingStatus?.key]).toEqual([
    initialStatus?.type,
    initialStatus?.key,
  ]);
  remainsFocusable(S.checking, true).props.onClick();
  expect(h.port.read).toHaveBeenCalledOnce();
  expect(h.port.status).not.toHaveBeenCalled();

  const request = h.request();
  h.read.resolve(pending(request));
  await flush();
  announcement(renderDialog(h), S.pending);
  remainsFocusable(S.check, false).props.onClick();
  await flush();
  announcement(renderDialog(h), S.checking);
  remainsFocusable(S.checking, true).props.onClick();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(request);

  h.status.resolve({
    ...pending(request),
    state: "ready",
    settled: true,
    configurationReport: {
      observedAtMs: 1000,
      source: "unreported",
      connectionStatus: "unreported",
      reportedItemCount: 0,
      itemsTruncated: false,
      items: [],
    },
  });
  await flush();
  remainsFocusable(S.refresh, false);
  announcement(
    renderDialog(h),
    "程序本次返回 0 项扩展配置，配置情况仍未确认。",
  );
});

it("announces a pending request from a previous opening only after an explicit status check", async () => {
  const h = fixture();
  getController.mockReturnValue(h.controller);
  activateRead(h);
  await flush();
  const request = h.request();
  h.read.resolve(failed(request, false, "timeout"));
  await flush();
  announcement(renderDialog(h), S.errors.timeout);

  hooks.values = [];
  announcement(renderDialog(h), "");
  activateRead(h);
  await flush();
  expect(h.port.status).toHaveBeenCalledExactlyOnceWith(request);
  announcement(renderDialog(h), S.checking);
  h.status.resolve(ready(request, []));
  await flush();
  announcement(
    renderDialog(h),
    "程序本次返回 0 项工具信息。报告完整性未提供。",
  );
});

it("announces the selected receipt or error and clears it when changing scope", async () => {
  const h = fixture();
  h.owner.sessionToolInventory = {
    ...capability,
    configuration: true,
    startup: {
      reportedCount: 1,
      loadedCount: 1,
      failedCount: 0,
      unknownCount: 0,
    },
    extensions: ["developer"],
  };
  getController.mockReturnValue(h.controller);
  const select = (value: string) => {
    const control = descendants(
      renderDialog(h).props.children as ReactNode,
    ).find((node) => node.type === "select");
    control!.props.onChange!({ target: { value } });
  };

  activateRead(h);
  await flush();
  h.read.resolve(ready(h.request()));
  await flush();
  announcement(renderDialog(h), "程序本次返回 1 项工具信息。");

  select("developer");
  announcement(renderDialog(h), "");
  select("");
  announcement(renderDialog(h), "");
  select("developer");
  const empty = deferred();
  h.port.read.mockReturnValueOnce(empty.promise);
  activateRead(h);
  await flush();
  expect(h.request().extensionName).toBe("developer");
  empty.resolve(ready(h.request(), []));
  await flush();
  expect(h.controller.getSnapshot().lastReport?.value.reportedItemCount).toBe(
    1,
  );
  announcement(
    renderDialog(h),
    "程序本次返回 0 项工具信息，该扩展的工具情况仍未确认。",
  );

  const failure = deferred();
  h.port.read.mockReturnValueOnce(failure.promise);
  activateRead(h);
  await flush();
  failure.resolve(failed(h.request()));
  await flush();
  expect(h.controller.getSnapshot().lastReport?.value.reportedItemCount).toBe(
    1,
  );
  announcement(renderDialog(h), S.errors.queryFailed);
  h.replace();
  announcement(renderDialog(h), "");
});

const report: SessionToolsReport = {
  observedAtMs: 1000,
  completeness: "unreported",
  reportedItemCount: 0,
  itemsTruncated: false,
  items: [],
};
it("shows the configuration separately with both source and connection unknown", () => {
  const html = renderToStaticMarkup(
    <SessionToolConfigurationView
      report={{
        observedAtMs: 1000,
        source: "unreported",
        connectionStatus: "unreported",
        reportedItemCount: 2,
        itemsTruncated: false,
        items: [
          { name: "HTTP Test", kind: "http" },
          { name: null, kind: "local" },
        ],
      }}
    />,
  );
  expect(html).toContain("对话扩展配置报告");
  expect(html).toContain(
    "程序未说明这些设置是本对话保存的，还是沿用的默认设置。",
  );
  expect(html).toContain("当前连接状态未提供。");
  expect(html).toContain("HTTP Test");
  expect(html).toContain("名称未提供");
  expect(html).not.toContain("已连接");
});
it("presents the empty configuration receipt separately from the previous returned entries", () => {
  const base = {
    observedAtMs: 1000,
    source: "unreported" as const,
    connectionStatus: "unreported" as const,
    itemsTruncated: false,
  };
  const html = renderToStaticMarkup(
    <>
      <SessionToolConfigurationView
        report={{ ...base, reportedItemCount: 0, items: [] }}
      />
      <SessionToolConfigurationView
        previous
        report={{
          ...base,
          reportedItemCount: 1,
          items: [{ name: "HTTP Test", kind: "http" }],
        }}
      />
    </>,
  );
  expect(html).toContain("这次没有返回扩展配置，配置情况仍未确认。");
  expect(html).toContain("程序本次返回 0 项扩展配置");
  expect(html).toContain("上次收到的报告");
  expect(html).toContain("程序上次返回 1 项扩展配置");
  expect(html).toContain("HTTP Test");
});
it("keeps a successful zero-item report incomplete and makes no absence or connection claim", () => {
  const html = renderToStaticMarkup(<SessionToolsReportView report={report} />);
  expect(html).toContain("程序本次返回 0 项工具信息");
  expect(html).toContain("报告完整性未提供");
  expect(html).not.toContain("没有工具");
  expect(html).not.toContain("已连接");
  expect(html).not.toContain("调用成功");
});
it("renders descriptions literally and separates reported permission from execution", () => {
  const html = renderToStaticMarkup(
    <SessionToolsReportView
      report={{
        ...report,
        reportedItemCount: 2,
        items: [
          {
            name: "<script>bad</script>",
            description:
              '[link](https://example.invalid) <img src="x" onerror="bad()">',
            permission: "ask_before",
            nameTruncated: false,
            descriptionTruncated: true,
          },
          {
            name: "<script>bad</script>",
            description: null,
            permission: null,
            nameTruncated: true,
            descriptionTruncated: false,
          },
        ],
      }}
    />,
  );
  expect(html).toContain("&lt;script&gt;bad&lt;/script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).not.toContain("<img");
  expect(html).not.toContain("<a ");
  expect(html.match(/<li>/g)).toHaveLength(2);
  expect(html).toContain("需要先确认");
  expect(html).toContain("尚未提供");
  expect(html).toContain("实际调用权限以请求时的确认为准");
  expect(html).toContain("名称已截短");
  expect(html).toContain("说明已截短");
});
it("reports truncation without changing the returned count to the displayed subset", () => {
  const html = renderToStaticMarkup(
    <SessionToolsReportView
      report={{ ...report, reportedItemCount: 400, itemsTruncated: true }}
    />,
  );
  expect(html).toContain("程序本次返回 400 项工具信息");
  expect(html).toContain("部分工具信息未展示");
  expect(html).toContain("报告完整性未提供");
});
it("renders opening extension diagnostics separately from present connection or call results", () => {
  const html = renderToStaticMarkup(
    <SessionToolStartupView
      report={{
        reportedCount: 257,
        loadedCount: 253,
        failedCount: 1,
        unknownCount: 2,
      }}
    />,
  );
  expect(html).toContain("打开对话时的扩展加载报告");
  expect(html).toContain("程序报告 257 项结果");
  expect(html).toContain("报告加载成功 253 项");
  expect(html).toContain("报告加载失败 1 项");
  expect(html).toContain("结果无法确认 2 项");
  expect(html).toContain("部分加载结果未统计");
  expect(html).not.toContain("已连接");
  expect(html).not.toContain("调用成功");
});
