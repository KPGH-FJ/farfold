import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { CodexAcpScope } from "../runtime/codex-acp-contract";
import {
  CodexAdmissionPrivateView,
  type CodexAdmissionPort,
} from "../runtime/codex-acp-admission";
import { CodexModelFields } from "./CodexModelFields";
export function CodexAcpModelPanel({
  scope,
  viewKey,
  port,
  onChoice,
}: {
  scope: CodexAcpScope | null;
  viewKey: string;
  port: CodexAdmissionPort;
  onChoice?: (
    choice:
      | Extract<
          import("../runtime/codex-acp-session").CodexSessionCommand,
          { action: "start" }
        >["choice"]
      | null,
  ) => void;
}) {
  return (
    <section
      className="codex-installation-result"
      aria-label="Codex ACP 模型选择"
    >
      <h3>模型选择</h3>
      {scope && port.allowed ? (
        <Controls
          key={JSON.stringify([scope, viewKey, port.bound])}
          scope={scope}
          port={port}
          onChoice={onChoice}
        />
      ) : (
        <p role="status">
          自有连接未就绪或模型选择当前不可用；不会读取账号或调用模型。
        </p>
      )}
    </section>
  );
}
function Controls({
  scope,
  port,
  onChoice,
}: {
  scope: CodexAcpScope;
  port: CodexAdmissionPort;
  onChoice?: (
    choice:
      | Extract<
          import("../runtime/codex-acp-session").CodexSessionCommand,
          { action: "start" }
        >["choice"]
      | null,
  ) => void;
}) {
  const latest = useRef(port);
  latest.current = port;
  const [owner] = useState(
    () => new CodexAdmissionPrivateView(scope, () => latest.current),
  );
  const state = useSyncExternalStore(
    owner.subscribe,
    owner.getSnapshot,
    owner.getSnapshot,
  );
  const [modelId, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [provider, setProvider] = useState("");
  useEffect(() => {
    owner.activate();
    return () => owner.retire();
  }, [owner]);
  const notify = useRef(onChoice);
  notify.current = onChoice;
  useEffect(
    () =>
      owner.subscribe(() => {
        const s = owner.getSnapshot().snapshot;
        notify.current?.(
          s?.selection && s.catalogHash
            ? {
                observationScope: s.scope,
                epoch: s.epoch,
                catalogHash: s.catalogHash,
                selection: s.selection,
              }
            : null,
        );
      }),
    [owner],
  );
  const catalog = state.snapshot?.catalog;
  const models =
    catalog?.filter((m) => !m.hidden && m.inputModalities.includes("text")) ??
    [];
  const model = models.find((m) => m.id === modelId);
  const disabled =
    state.busy ||
    port.bound ||
    !catalog ||
    state.snapshot?.account?.kind === "unauthenticated";
  if (!port.current())
    return <p role="status">原连接已变化；旧目录和选择不可用。</p>;
  return (
    <>
      <p>目录观察和明确选择不代表原生 actual 已确认，也不授予任务能力。</p>
      <button
        disabled={state.busy}
        onClick={() => {
          setModel("");
          setEffort("");
          setProvider("");
          void owner.refresh();
        }}
      >
        读取账号与完整模型目录
      </button>
      {state.busy && <p role="status">正在核对原连接目录或明确选择…</p>}
      {state.snapshot && (
        <p role="status">
          账号观察：{state.snapshot.account?.kind}；完整目录 {catalog?.length}{" "}
          项，可选 {models.length} 项。版本 {state.snapshot.epoch}
        </p>
      )}
      {port.bound && (
        <p role="status">当前 Session 的模型选择已绑定；此入口不可改写。</p>
      )}
      <CodexModelFields
        models={models}
        modelId={modelId}
        effort={effort}
        disabled={disabled}
        effortDisabled={disabled || !model}
        onModel={(v) => {
          owner.edit();
          setModel(v);
          setEffort("");
        }}
        onEffort={(v) => {
          owner.edit();
          setEffort(v);
        }}
      />
      <label>
        预期 Provider ID
        <input
          value={provider}
          maxLength={200}
          autoComplete="off"
          disabled={disabled}
          placeholder="明确输入原生 Provider ID"
          onChange={(e) => {
            owner.edit();
            setProvider(e.target.value);
          }}
        />
      </label>
      <button
        disabled={
          disabled ||
          !model ||
          !model.supportedReasoningEfforts.some(
            (e) => e.reasoningEffort === effort,
          ) ||
          !/^[A-Za-z0-9_.:/-]{1,200}$/.test(provider)
        }
        onClick={() => {
          if (model)
            void owner.select({
              catalogModelId: model.id,
              nativeModel: model.model,
              provider,
              reasoningEffort: effort,
            });
        }}
      >
        确认明确选择
      </button>
      {state.snapshot?.selection && (
        <p role="status">
          本视图已提交明确选择：{state.snapshot.selection.nativeModel} /{" "}
          {state.snapshot.selection.reasoningEffort} /{" "}
          {state.snapshot.selection.provider}。原生 actual 与任务能力仍未确认。
        </p>
      )}
      {state.error && (
        <p className="auth-error" role="alert">
          {state.error}
        </p>
      )}
    </>
  );
}
