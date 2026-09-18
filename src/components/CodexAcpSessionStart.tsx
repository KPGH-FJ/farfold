import { useEffect, useRef, useState, type ReactNode } from "react";
import { SessionStartPanel } from "./SessionStartPanel";
import { CodexAcpModelPanel } from "./CodexAcpModelPanel";
import {
  CODEX_ACP_CLOSED_REASON,
  sameCodexAcpScope,
  type CodexAcpWorkspaceSnapshot,
} from "../runtime/codex-acp-workspace";
import type { CodexAcpScope } from "../runtime/codex-acp-contract";
import { codexWorkspaceBackend } from "../runtime/codex-workspace-backend";
import {
  listCodexInstallations,
  type SavedCodexInstallation,
} from "../runtime/codex-installation";
import {
  workingCopySnapshot,
  type WorkingCopyRecord,
} from "../runtime/working-copy";
import {
  activateCodexSessionReceipt,
  readCodexSessionContext,
  type CodexSessionContext,
} from "../runtime/codex-acp-session-entry";
import type { HostSessionBinding } from "../runtime/host-shadow";
import type { CodexSessionCommand } from "../runtime/codex-acp-session";
import {
  describeSessionOpening,
  sessionOpeningError,
  type SessionOpeningTarget,
} from "../runtime/session-opening";

type Choice = Extract<CodexSessionCommand, { action: "start" }>["choice"];
/** Session entry: Connect the owned profile first, then read context and start/open. */
export function CodexAcpSessionStart({
  binding,
  projectPath,
  chooseProject,
  allowed,
  snapshot,
  connect,
  current,
  onActivated,
  children,
}: {
  binding: HostSessionBinding | null;
  projectPath: string | null;
  chooseProject: () => void;
  allowed: boolean;
  /** Latest workspace snapshot for this page; connection state drives the flow. */
  snapshot: CodexAcpWorkspaceSnapshot | null;
  connect: (
    installationId: string,
    workingCopyId: string,
  ) => Promise<CodexAcpScope>;
  current: () => boolean;
  onActivated: (binding: HostSessionBinding) => void;
  children?: ReactNode;
}) {
  const [installations, setInstallations] = useState<SavedCodexInstallation[]>(
    [],
  );
  const [copies, setCopies] = useState<WorkingCopyRecord[]>([]);
  const [installationId, setInstallationId] = useState("");
  const [context, setContext] = useState<CodexSessionContext | null>(null);
  const [choice, setChoice] = useState<Choice | null>(null);
  const [busy, setBusy] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const openingTarget: SessionOpeningTarget = binding
    ? { kind: "open", sessionId: binding.farfoldSessionId, session: binding }
    : { kind: "create", projectPath: projectPath ?? "" };
  const revision = useRef(0);
  const mounted = useRef(true);
  const latest = useRef({ allowed, current, connect, onActivated });
  latest.current = { allowed, current, connect, onActivated };
  const ownKey = JSON.stringify([binding, projectPath, installationId]);
  const keyRef = useRef(ownKey);
  if (keyRef.current !== ownKey) {
    keyRef.current = ownKey;
    ++revision.current;
  }
  const selected = copies.filter(
    (c) =>
      c.canonicalPath === projectPath &&
      c.pathState === "ready" &&
      !c.removalState &&
      (!c.managedState || c.managedState === "ready"),
  );
  const copy = selected.length === 1 ? selected[0] : null;
  const installation = installations.find(
    (i) => i.installationId === installationId,
  );
  const viewCurrent = () =>
    mounted.current &&
    ownKey === keyRef.current &&
    latest.current.allowed &&
    latest.current.current();
  useEffect(() => {
    mounted.current = true;
    if (allowed && !binding) {
      const expected = revision.current;
      void Promise.all([listCodexInstallations(), workingCopySnapshot()])
        .then(([i, w]) => {
          if (viewCurrent() && expected === revision.current) {
            setInstallations(i);
            setCopies(w.workingCopies);
          }
        })
        .catch(() => {
          if (viewCurrent())
            setError("已登记的程序或工作副本无法读取；不会自动注册。");
        });
    }
    return () => {
      mounted.current = false;
      ++revision.current;
    };
  }, []);
  function invalidate() {
    ++revision.current;
    setContext(null);
    setChoice(null);
    setBusy(false);
    setError(null);
  }
  async function connectAndRead() {
    if (
      !viewCurrent() ||
      busy ||
      attempted ||
      (!binding && (!copy || !installation))
    )
      return;
    invalidate();
    const expected = revision.current;
    setBusy(true);
    try {
      const scope = await latest.current.connect(
        binding ? binding.installationId : installation!.installationId,
        binding ? binding.workingCopyId : copy!.workingCopyId,
      );
      if (!viewCurrent() || expected !== revision.current) return;
      const c = await readCodexSessionContext(
        binding
          ? { action: "open", farfoldSessionId: binding.farfoldSessionId }
          : {
              action: "start",
              installationId: scope.installationId,
              runtimeBuildId: scope.runtimeBuildId,
              workingCopyId: copy!.workingCopyId,
            },
      );
      if (!viewCurrent() || expected !== revision.current) return;
      if (
        c.cwd !== projectPath ||
        !sameCodexAcpScope(c.scope, scope) ||
        (binding &&
          (c.workingCopyId !== binding.workingCopyId ||
            c.projectId !== binding.projectId ||
            c.scope.installationId !== binding.installationId ||
            c.scope.runtimeBuildId !== binding.runtimeBuildId ||
            c.scope.connectionId !== binding.connectionId))
      )
        throw new Error();
      setContext(c);
    } catch {
      if (viewCurrent() && expected === revision.current)
        setError(
          "无法连接自有环境或匹配已登记工作副本；不会创建或恢复其他连接。",
        );
    } finally {
      if (viewCurrent() && expected === revision.current) setBusy(false);
    }
  }
  function onChoice(next: Choice | null) {
    ++revision.current;
    setChoice(next);
    setBusy(false);
  }
  async function enter() {
    if (
      !viewCurrent() ||
      busy ||
      attempted ||
      !context ||
      (!binding && !choice)
    )
      return;
    const expected = ++revision.current;
    const stillCurrent = () => viewCurrent() && expected === revision.current;
    const backend = codexWorkspaceBackend(
      binding,
      stillCurrent,
      undefined,
      context.scope,
      context.workingCopyId,
    );
    setAttempted(true);
    setBusy(true);
    setError(null);
    try {
      // Fresh read of the exact relation just before dispatch, never an implicit restore.
      const fresh = await readCodexSessionContext(
        binding
          ? { action: "open", farfoldSessionId: binding.farfoldSessionId }
          : {
              action: "start",
              installationId: context.scope.installationId,
              runtimeBuildId: context.scope.runtimeBuildId,
              workingCopyId: context.workingCopyId,
            },
      );
      if (!stillCurrent()) return;
      if (
        !sameCodexAcpScope(fresh.scope, context.scope) ||
        fresh.cwd !== context.cwd ||
        fresh.projectId !== context.projectId ||
        fresh.workingCopyId !== context.workingCopyId
      )
        throw new Error();
      const receipt = await backend.sessionAcp(
        context.scope,
        binding
          ? { action: "open", farfoldSessionId: binding.farfoldSessionId }
          : {
              action: "start",
              workingCopyId: context.workingCopyId,
              choice: choice!,
            },
      );
      const registered = await activateCodexSessionReceipt(
        receipt,
        stillCurrent,
        fresh.navigationExpectation,
      );
      if (stillCurrent()) latest.current.onActivated(registered);
    } catch {
      if (stillCurrent())
        setError(
          sessionOpeningError(
            openingTarget,
            "codex",
            "会话结果未确认；没有激活、重试或改用其他连接。请保留原会话核对。",
          ),
        );
    } finally {
      if (stillCurrent()) setBusy(false);
    }
  }
  const modelBackend = context
    ? codexWorkspaceBackend(
        binding,
        viewCurrent,
        undefined,
        context.scope,
        context.workingCopyId,
      )
    : null;
  return (
    <SessionStartPanel
      title={binding ? "Codex ACP 原绑定会话" : "新建 Codex ACP 会话"}
      description={CODEX_ACP_CLOSED_REASON}
      connection={<button disabled>程序与账号设置</button>}
      projectPath={projectPath}
      projectLocked={!!binding}
      chooseProject={chooseProject}
      busy={false}
      unavailable={
        !allowed || busy || attempted || !context || (!binding && !choice)
      }
      create={() => void enter()}
      primaryLabel={
        !allowed
          ? "ACP 入口暂未开放"
          : busy
            ? describeSessionOpening(openingTarget, "codex").action
            : binding
              ? "打开原绑定 Session"
              : "新建 Session"
      }
    >
      {!binding && (
        <label>
          已登记 Codex 程序
          <select
            aria-label="已登记 Codex 程序"
            value={installationId}
            disabled={!allowed || busy || attempted}
            onChange={(e) => {
              invalidate();
              setInstallationId(e.target.value);
            }}
          >
            <option value="">明确选择已登记程序</option>
            {installations.map((i) => (
              <option key={i.installationId} value={i.installationId}>
                {i.installationId} · {i.inspection.version}
              </option>
            ))}
          </select>
        </label>
      )}
      <button
        disabled={
          !allowed ||
          busy ||
          attempted ||
          (!binding && (!copy || !installation))
        }
        onClick={() => void connectAndRead()}
      >
        {binding ? "连接自有环境并核对原绑定" : "连接自有环境并核对工作副本"}
      </button>
      {context && (
        <p role="status">
          已核对原连接 · {context.workingCopyId} · 代次{" "}
          {context.scope.generation}；不代表任务可用。
        </p>
      )}
      {!binding && allowed && !copy && (
        <p role="status">
          此目录不是唯一匹配的已登记可用工作副本；本入口不会注册或创建工作副本。
        </p>
      )}
      <CodexAcpModelPanel
        scope={context?.scope ?? null}
        viewKey={JSON.stringify([ownKey, context])}
        port={{
          allowed: allowed && (snapshot?.capabilities.selectModel ?? false),
          bound: !!binding,
          current: viewCurrent,
          request: (scope, command) => {
            if (!modelBackend)
              return Promise.reject(new Error("会话上下文未确认"));
            return modelBackend.admissionAcp(scope, command);
          },
        }}
        onChoice={onChoice}
      />
      {error && <p role="alert">{error}</p>}
      {children}
      {attempted && !busy && !error && (
        <p role="status">
          本视图已提交一次 Session
          操作；不会自动再次打开或新建。目标变化后的原结果需要按原身份核对。
        </p>
      )}
    </SessionStartPanel>
  );
}
