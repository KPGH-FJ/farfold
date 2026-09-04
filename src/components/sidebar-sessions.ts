import type {
  HostPendingInteraction,
  HostSessionBinding,
} from "../runtime/host-shadow";

export interface SidebarSessionItem {
  key: string;
  runtimeProductId: string;
  nativeSessionId: string;
  projectPath: string;
  title: string;
  updatedAt: number;
  runtimeLabel: string;
  pinned: boolean;
  archivedAt: number | null;
  attention: boolean;
}

export interface SidebarProjectGroup {
  path: string;
  name: string;
  sessions: SidebarSessionItem[];
  latestUpdatedAt: number;
}

export function sessionNavigationDisabled(
  visibleRuntimeProductId: string,
  targetRuntimeProductId: string,
  visibleRuntimeWorking: boolean,
  lifecycleBlocked: boolean,
): boolean {
  return (
    lifecycleBlocked ||
    (visibleRuntimeProductId === targetRuntimeProductId &&
      visibleRuntimeWorking)
  );
}

export function projectNameFromPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function runtimeLabel(runtimeProductId: string): string {
  if (runtimeProductId === "pi") return "Pi";
  if (runtimeProductId === "opencode") return "OpenCode";
  return runtimeProductId;
}

export function sidebarSessionsFromHost(
  sessions: HostSessionBinding[],
  pendingInteractions: HostPendingInteraction[] = [],
): SidebarSessionItem[] {
  return sessions.map((session) => ({
    key: session.farfoldSessionId,
    runtimeProductId: session.runtimeProductId,
    nativeSessionId: session.nativeSessionId,
    projectPath: session.workingCopyPath,
    title: session.title,
    updatedAt: session.updatedAt,
    runtimeLabel: runtimeLabel(session.runtimeProductId),
    pinned: session.pinned,
    archivedAt: session.archivedAt,
    attention: pendingInteractions.some(
      (interaction) =>
        interaction.runtime.productId === session.runtimeProductId &&
        interaction.runtime.installationId === session.installationId &&
        interaction.nativeSessionId === session.nativeSessionId,
    ),
  }));
}

export function orderArchivedSidebarSessions(
  sessions: SidebarSessionItem[],
): SidebarSessionItem[] {
  return [...sessions].sort(
    (left, right) =>
      (right.archivedAt ?? 0) - (left.archivedAt ?? 0) ||
      right.updatedAt - left.updatedAt ||
      left.key.localeCompare(right.key),
  );
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

export function groupSidebarSessionsByProject(
  sessions: SidebarSessionItem[],
): SidebarProjectGroup[] {
  const grouped = new Map<string, SidebarSessionItem[]>();
  for (const session of sessions) {
    const projectSessions = grouped.get(session.projectPath) ?? [];
    projectSessions.push(session);
    grouped.set(session.projectPath, projectSessions);
  }

  return Array.from(grouped, ([path, projectSessions]) => {
    const orderedSessions = orderSidebarSessions(projectSessions);
    return {
      path,
      name: projectNameFromPath(path),
      sessions: orderedSessions,
      latestUpdatedAt: Math.max(
        ...orderedSessions.map((session) => session.updatedAt),
      ),
    };
  }).sort(
    (left, right) =>
      right.latestUpdatedAt - left.latestUpdatedAt ||
      left.path.localeCompare(right.path),
  );
}

export function matchesSidebarSession(
  session: SidebarSessionItem,
  query: string,
): boolean {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) return true;
  return [
    session.title,
    session.runtimeLabel,
    projectNameFromPath(session.projectPath),
    session.projectPath,
  ].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
}
