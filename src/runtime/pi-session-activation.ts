import {
  createHostSession,
  openHostSession,
  type HostSessionOpenResult,
  type HostSessionStartOptions,
} from "./host-shadow";
import {
  stopHostPiAcpRuntime,
  stopHostPiRuntime,
} from "./host-runtime-lifecycle";
import { piRuntimeAdapter, type ProjectTrust, type RuntimeStatus } from "./pi";
import {
  PI_ACP_ADAPTER_ID,
  piAcpStatus,
  piAcpTargetForBinding,
  type PiAcpStatus,
  type PiAcpTarget,
} from "./pi-acp";
import { sessionStartInput } from "./session-start";

export type PiSessionActivation =
  | { kind: "create"; workingCopyPath: string; replaceRunning: boolean }
  | { kind: "open"; farfoldSessionId: string };

// Only sequences the existing Host controls. Native identity, Working Copy
// admission and creation/resume remain Host and Runtime responsibilities.
export async function activatePiSession(
  target: PiSessionActivation,
  options: {
    projectTrust: ProjectTrust;
    running: boolean;
    phase: (phase: "stopping" | "starting") => void;
    applyStatus: (status: RuntimeStatus) => boolean;
    adapterId?: "pi-rpc-jsonl" | typeof PI_ACP_ADAPTER_ID;
    managedProvider?: {
      providerConnectionId: string;
      providerConfigVersionId: string;
    };
    nativeFirstUse?: boolean;
    runningAcpTarget?: PiAcpTarget;
    applyAcpStatus?: (status: PiAcpStatus) => boolean;
    beforeStart?: () => Promise<void>;
    applyOpened: (
      opened: HostSessionOpenResult,
      projectPath: string,
    ) => Promise<void>;
  },
): Promise<void> {
  if (
    !(
      target.kind === "create"
        ? target.workingCopyPath
        : target.farfoldSessionId
    ).trim()
  ) {
    throw new Error("缺少 Pi Project 或 Host Session 绑定，未启动 Runtime。");
  }
  const acp = options.adapterId === PI_ACP_ADAPTER_ID;
  if ((acp || options.runningAcpTarget) && !options.applyAcpStatus) {
    throw new Error("Pi ACP 状态接线不可用，未改变原连接。");
  }
  const nativeOptions: HostSessionStartOptions = acp
    ? {
        runtimeProductId: "pi",
        projectTrust: options.projectTrust,
        adapterId: PI_ACP_ADAPTER_ID,
        ...(target.kind === "create"
          ? { managedProvider: options.managedProvider }
          : {}),
        ...(target.kind === "create" && options.nativeFirstUse
          ? { nativeFirstUse: true }
          : {}),
      }
    : { runtimeProductId: "pi", projectTrust: options.projectTrust };
  const createInput =
    target.kind === "create"
      ? sessionStartInput(target.workingCopyPath, nativeOptions)
      : null;
  if (options.running && (target.kind === "open" || target.replaceRunning)) {
    options.phase("stopping");
    if (options.runningAcpTarget) {
      const stopped = await stopHostPiAcpRuntime(options.runningAcpTarget);
      if (!options.applyAcpStatus!(stopped) || stopped.running) {
        throw new Error("Pi ACP 停止尚未确认，未打开另一条 Session。");
      }
    } else {
      const stopped = await stopHostPiRuntime();
      if (
        !options.applyStatus(stopped) ||
        stopped.running ||
        stopped.state !== "stopped"
      ) {
        throw new Error("Pi 停止尚未确认，未打开另一条 Session。");
      }
    }
  }
  await options.beforeStart?.();
  options.phase("starting");
  const opened =
    target.kind === "create"
      ? await createHostSession(createInput!)
      : await openHostSession(target.farfoldSessionId, nativeOptions);
  const status = acp ? await piAcpStatus() : await piRuntimeAdapter.status();
  const binding = opened.navigation.sessionIndex.sessions.find(
    (session) => session.farfoldSessionId === opened.farfoldSessionId,
  );
  const currentProject = "state" in status ? status.projectPath : status.cwd;
  const connectionMatches =
    "state" in status
      ? !acp && status.state === "running"
      : acp && binding && piAcpTargetForBinding(status, binding) !== null;
  if (
    opened.runtimeProductId !== "pi" ||
    (target.kind === "open" &&
      opened.farfoldSessionId !== target.farfoldSessionId) ||
    !binding ||
    binding.runtimeProductId !== "pi" ||
    binding.installationId !== opened.installationId ||
    !opened.nativeSessionId ||
    binding.nativeSessionId !== opened.nativeSessionId ||
    !status.running ||
    !connectionMatches ||
    status.generation !== opened.runtimeGeneration ||
    !currentProject ||
    currentProject !== binding.workingCopyPath
  ) {
    throw new Error(
      "Pi 打开结果与当前进程或 Host 绑定不一致，未加载该 Session。请核对 Runtime 状态后重试。",
    );
  }
  const applied =
    "state" in status
      ? options.applyStatus(status)
      : options.applyAcpStatus!(status);
  if (!applied) {
    throw new Error("Pi 打开结果已过期，未加载旧进程的 Session。");
  }
  await options.applyOpened(opened, binding.workingCopyPath);
}
