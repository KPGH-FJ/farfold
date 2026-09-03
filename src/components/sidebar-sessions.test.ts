import { describe, expect, it } from "vitest";
import type { HostSessionBinding } from "../runtime/host-shadow";
import {
  groupSidebarSessionsByProject,
  matchesSidebarSession,
  orderArchivedSidebarSessions,
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
  it("keeps supported Runtime and archive identities together", () => {
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

    expect(
      items.map(({ key, runtimeLabel, archivedAt }) => [
        key,
        runtimeLabel,
        archivedAt,
      ]),
    ).toEqual([
      ["pi-1", "Pi", null],
      ["open-code-1", "OpenCode", null],
      ["archived", "Pi", 9],
    ]);
  });

  it("marks attention only when Runtime installation and native Session all match", () => {
    const pi = session({
      farfoldSessionId: "pi-1",
      runtimeProductId: "pi",
    });
    const openCode = session({
      farfoldSessionId: "open-code-1",
      runtimeProductId: "opencode",
    });
    const items = sidebarSessionsFromHost(
      [pi, openCode],
      [
        {
          runtime: {
            productId: "pi",
            installationId: pi.installationId,
            adapterId: pi.adapterId,
          },
          runtimeGeneration: 4,
          interactionId: "interaction-1",
          nativeSessionId: pi.nativeSessionId,
          kind: "pi_extension_dialog",
          state: "pending",
        },
        {
          runtime: {
            productId: "opencode",
            installationId: "another-installation",
            adapterId: openCode.adapterId,
          },
          runtimeGeneration: 4,
          interactionId: "interaction-2",
          nativeSessionId: openCode.nativeSessionId,
          kind: "open_code_permission",
          state: "pending",
        },
      ],
    );

    expect(items.map(({ key, attention }) => [key, attention])).toEqual([
      ["pi-1", true],
      ["open-code-1", false],
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

describe("orderArchivedSidebarSessions", () => {
  it("uses latest archive time without treating old pins as current shortcuts", () => {
    const items = sidebarSessionsFromHost([
      session({
        farfoldSessionId: "older-pinned",
        runtimeProductId: "pi",
        archivedAt: 10,
        pinned: true,
      }),
      session({
        farfoldSessionId: "newer",
        runtimeProductId: "opencode",
        archivedAt: 30,
      }),
    ]);

    expect(orderArchivedSidebarSessions(items).map((item) => item.key)).toEqual(
      ["newer", "older-pinned"],
    );
  });
});

describe("groupSidebarSessionsByProject", () => {
  it("orders Projects by latest activity and Sessions by pinned then latest", () => {
    const items = sidebarSessionsFromHost([
      session({
        farfoldSessionId: "older-project-latest",
        runtimeProductId: "pi",
        workingCopyPath: "/tmp/older-project",
        updatedAt: 20,
      }),
      session({
        farfoldSessionId: "newer-project-latest",
        runtimeProductId: "opencode",
        workingCopyPath: "/tmp/newer-project",
        updatedAt: 40,
      }),
      session({
        farfoldSessionId: "newer-project-pinned",
        runtimeProductId: "pi",
        workingCopyPath: "/tmp/newer-project",
        updatedAt: 10,
        pinned: true,
      }),
    ]);

    const groups = groupSidebarSessionsByProject(items);

    expect(groups.map(({ name }) => name)).toEqual([
      "newer-project",
      "older-project",
    ]);
    expect(groups[0]?.sessions.map(({ key }) => key)).toEqual([
      "newer-project-pinned",
      "newer-project-latest",
    ]);
  });
});

describe("matchesSidebarSession", () => {
  it("matches title, Runtime label, Project name, and full Project path", () => {
    const [item] = sidebarSessionsFromHost([
      session({
        farfoldSessionId: "session-1",
        runtimeProductId: "opencode",
        title: "Repair permissions",
        workingCopyPath: "/Users/example/desktop/farfold",
      }),
    ]);

    expect(item).toBeDefined();
    expect(matchesSidebarSession(item!, "permissions")).toBe(true);
    expect(matchesSidebarSession(item!, "opencode")).toBe(true);
    expect(matchesSidebarSession(item!, "farfold")).toBe(true);
    expect(matchesSidebarSession(item!, "/users/example")).toBe(true);
    expect(matchesSidebarSession(item!, "missing")).toBe(false);
  });
});
