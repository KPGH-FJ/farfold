import type { HostSessionBinding } from "../runtime/host-shadow";

export interface SidebarSessionItem {
  key: string;
  runtimeProductId: string;
  nativeSessionId: string;
  projectPath: string;
  title: string;
  updatedAt: number;
  runtimeLabel: string;
  pinned: boolean;
}

function runtimeLabel(runtimeProductId: string): string {
  if (runtimeProductId === "pi") return "Pi";
  if (runtimeProductId === "opencode") return "OpenCode";
  return runtimeProductId;
}

export function sidebarSessionsFromHost(
  sessions: HostSessionBinding[],
): SidebarSessionItem[] {
  return sessions
    .filter((session) => session.archivedAt === null)
    .map((session) => ({
      key: session.farfoldSessionId,
      runtimeProductId: session.runtimeProductId,
      nativeSessionId: session.nativeSessionId,
      projectPath: session.workingCopyPath,
      title: session.title,
      updatedAt: session.updatedAt,
      runtimeLabel: runtimeLabel(session.runtimeProductId),
      pinned: session.pinned,
    }));
}

export function orderSidebarSessions(
  sessions: SidebarSessionItem[],
): SidebarSessionItem[] {
  return [...sessions].sort(
    (left, right) =>
      Number(right.pinned) - Number(left.pinned) ||
      right.updatedAt - left.updatedAt ||
      left.key.localeCompare(right.key),
  );
}
