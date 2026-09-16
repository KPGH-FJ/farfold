import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import {
  sameCodexAcpScope,
  CodexAcpWorkspaceReader,
} from "./codex-acp-workspace";
import type { HostSessionBinding, HostNavigationSnapshot } from "./host-shadow";
import { replaceHostNavigation } from "./host-shadow";
import type { CodexSessionReceipt } from "./codex-acp-session";

export type CodexSessionContextInput =
  | {
      action: "start";
      installationId: string;
      runtimeBuildId: string;
      workingCopyId: string;
    }
  | { action: "open"; farfoldSessionId: string };
export interface CodexSessionContext {
  scope: CodexAcpScope;
  projectId: string;
  workingCopyId: string;
  cwd: string;
  navigationExpectation: NavigationExpectation;
}
export type NavigationExpectation =
  | { kind: "absent" }
  | {
      kind: "present";
      lastProjectId: string | null;
      lastSessionId: string | null;
      updatedAt: number;
    };
function checkedNavigationExpectation(
  v: NavigationExpectation,
): NavigationExpectation {
  if (v?.kind === "absent" && Object.keys(v).length === 1)
    return { kind: "absent" };
  if (
    v?.kind === "present" &&
    Object.keys(v).length === 4 &&
    (v.lastProjectId === null || id(v.lastProjectId)) &&
    (v.lastSessionId === null || id(v.lastSessionId)) &&
    Number.isSafeInteger(v.updatedAt)
  )
    return {
      kind: "present",
      lastProjectId: v.lastProjectId,
      lastSessionId: v.lastSessionId,
      updatedAt: v.updatedAt,
    };
  throw invalid();
}
const invalid = () =>
  new Error("原连接、工作副本或会话身份未确认；不会自动重试");
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
export async function readCodexSessionContext(
  input: CodexSessionContextInput,
): Promise<CodexSessionContext> {
  try {
    const r = await invoke<CodexSessionContext>(
      "host_codex_acp_session_context",
      { input },
    );
    const s = r?.scope;
    if (
      !s ||
      !sameCodexAcpScope(s, s) ||
      s.runtimeProductId !== "codex" ||
      s.adapterId !== "codex-acp-stdio-v1" ||
      ![
        s.installationId,
        s.runtimeBuildId,
        s.adapterBuildId,
        s.connectionId,
        s.profileId,
        r.projectId,
        r.workingCopyId,
      ].every(id) ||
      !Number.isSafeInteger(s.generation) ||
      s.generation < 1 ||
      typeof r.cwd !== "string" ||
      !r.cwd.startsWith("/") ||
      r.cwd.includes("\0") ||
      Object.keys(r).some(
        (k) =>
          ![
            "scope",
            "projectId",
            "workingCopyId",
            "cwd",
            "navigationExpectation",
          ].includes(k),
      ) ||
      (input.action === "start" &&
        (s.installationId !== input.installationId ||
          s.runtimeBuildId !== input.runtimeBuildId ||
          r.workingCopyId !== input.workingCopyId))
    )
      throw invalid();
    return {
      scope: { ...s },
      projectId: r.projectId,
      workingCopyId: r.workingCopyId,
      cwd: r.cwd,
      navigationExpectation: checkedNavigationExpectation(
        r.navigationExpectation,
      ),
    };
  } catch {
    throw invalid();
  }
}

function registeredBinding(
  n: HostNavigationSnapshot,
  r: CodexSessionReceipt,
  c: CodexSessionContext,
): HostSessionBinding {
  const matches = n.sessionIndex.sessions.filter(
    (b) => b.farfoldSessionId === r.farfoldSessionId,
  );
  const b = matches[0];
  if (
    matches.length !== 1 ||
    !b ||
    b.archivedAt !== null ||
    !b.nativeLocatorRegistered ||
    b.runtimeProductId !== r.scope.runtimeProductId ||
    b.adapterId !== r.scope.adapterId ||
    b.installationId !== r.scope.installationId ||
    b.runtimeBuildId !== r.scope.runtimeBuildId ||
    b.connectionId !== r.scope.connectionId ||
    b.nativeSessionId !== r.nativeThreadId ||
    b.workingCopyId !== r.workingCopyId ||
    b.workingCopyId !== c.workingCopyId ||
    b.projectId !== c.projectId ||
    b.workingCopyPath !== c.cwd
  )
    throw invalid();
  return b;
}

/** Re-read the shared index and original target. Never invoke native open a second time. */
export async function activateCodexSessionReceipt(
  r: CodexSessionReceipt,
  current: () => boolean,
  expectedNavigation: NavigationExpectation,
): Promise<HostSessionBinding> {
  const check = () => {
    if (!current()) throw invalid();
  };
  check();
  const context = await readCodexSessionContext({
    action: "open",
    farfoldSessionId: r.farfoldSessionId,
  });
  check();
  if (!sameCodexAcpScope(context.scope, r.scope)) throw invalid();
  const navigation = await invoke<HostNavigationSnapshot>(
    "host_navigation_snapshot",
  );
  check();
  let binding = registeredBinding(navigation, r, context);
  const state = await new CodexAcpWorkspaceReader().read(binding);
  check();
  if (
    !state?.scope ||
    !sameCodexAcpScope(state.scope, r.scope) ||
    state.connectionState !== "connected" ||
    state.target?.nativeTreeId !== r.nativeTreeId ||
    !state.admission?.actual ||
    !(
      ["catalogModelId", "nativeModel", "provider", "reasoningEffort"] as const
    ).every((k) => state.admission!.actual![k] === r.selection[k])
  )
    throw invalid();
  // The token comes from BEFORE start/open. Never replace it with this late read.
  const focused = await invoke<{
    kind: string;
    scope: CodexAcpScope;
    farfoldSessionId: string;
    navigation: HostNavigationSnapshot;
  }>("host_codex_acp_operation", {
    input: {
      action: "focus",
      receipt: r,
      expectedNavigation: checkedNavigationExpectation(expectedNavigation),
    },
  }).catch(() => {
    throw invalid();
  });
  check();
  if (
    focused?.kind !== "focused" ||
    !focused.scope ||
    !sameCodexAcpScope(focused.scope, r.scope) ||
    focused.farfoldSessionId !== r.farfoldSessionId
  )
    throw invalid();
  const committed = focused.navigation?.restoreState;
  if (
    !committed ||
    committed.lastSessionId !== r.farfoldSessionId ||
    committed.lastProjectId !== context.projectId ||
    !Number.isSafeInteger(committed.updatedAt) ||
    (expectedNavigation.kind === "present" &&
      committed.updatedAt <= expectedNavigation.updatedAt)
  )
    throw invalid();
  binding = registeredBinding(focused.navigation, r, context);
  const finalContext = await readCodexSessionContext({
    action: "open",
    farfoldSessionId: r.farfoldSessionId,
  });
  check();
  const finalNavigation = finalContext.navigationExpectation;
  if (
    !sameCodexAcpScope(finalContext.scope, r.scope) ||
    finalContext.projectId !== context.projectId ||
    finalContext.workingCopyId !== context.workingCopyId ||
    finalContext.cwd !== context.cwd ||
    finalNavigation.kind !== "present" ||
    finalNavigation.lastProjectId !== committed.lastProjectId ||
    finalNavigation.lastSessionId !== committed.lastSessionId ||
    finalNavigation.updatedAt !== committed.updatedAt
  )
    throw invalid();
  replaceHostNavigation(focused.navigation);
  check();
  return binding;
}
