import { describe, expect, it } from "vitest";
import type { HostSessionBinding } from "../runtime/host-shadow";
import {
  orderSidebarSessions,
  sidebarSessionsFromHost,
} from "./sidebar-sessions";

function session(
  overrides: Partial<HostSessionBinding> &
    Pick<HostSessionBinding, "farfoldSessionId" | "runtimeProductId">,
): HostSessionBinding {
  const { farfoldSessionId, runtimeProductId, ...rest } = overrides;
  return {
    farfoldSessionId,
    runtimeProductId,
    installationId: `${runtimeProductId}-installation`,
    runtimeBuildId: `${runtimeProductId}-build`,
    adapterId: `${runtimeProductId}-adapter`,
    connectionId: `${runtimeProductId}-connection`,
    projectId: "project-1",
    projectPath: "/tmp/project",
    projectName: "project",
    workingCopyId: "working-copy-1",
    workingCopyPath: "/tmp/project",
    workingCopyKind: "root",
    branchName: null,
    nativeSessionId: `${runtimeProductId}-native`,
    nativeLocatorRegistered: true,
    title: farfoldSessionId,
    titleSource: "native",
    pinned: false,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    ...rest,
  };
}

describe("sidebarSessionsFromHost", () => {
  it("keeps supported Runtime identities together and excludes archived Sessions", () => {
    const items = sidebarSessionsFromHost([
      session({ farfoldSessionId: "pi-1", runtimeProductId: "pi" }),
      session({
        farfoldSessionId: "open-code-1",
        runtimeProductId: "opencode",
      }),
      session({
        farfoldSessionId: "archived",
        runtimeProductId: "pi",
        archivedAt: 9,
      }),
    ]);

    expect(items.map(({ key, runtimeLabel }) => [key, runtimeLabel])).toEqual([
      ["pi-1", "Pi"],
      ["open-code-1", "OpenCode"],
    ]);
  });
});

describe("orderSidebarSessions", () => {
  it("places pinned Sessions first and otherwise uses latest update order", () => {
    const items = sidebarSessionsFromHost([
      session({
        farfoldSessionId: "latest",
        runtimeProductId: "pi",
        updatedAt: 30,
      }),
      session({
        farfoldSessionId: "pinned",
        runtimeProductId: "opencode",
        updatedAt: 10,
        pinned: true,
      }),
      session({
        farfoldSessionId: "middle",
        runtimeProductId: "pi",
        updatedAt: 20,
      }),
    ]);

    expect(orderSidebarSessions(items).map((item) => item.key)).toEqual([
      "pinned",
      "latest",
      "middle",
    ]);
  });
});
