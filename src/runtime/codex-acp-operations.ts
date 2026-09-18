import { invoke } from "@tauri-apps/api/core";
import type { CodexAcpScope } from "./codex-acp-contract";
import { sameCodexAcpScope } from "./codex-acp-workspace";
import type { CodexAcpContext } from "./codex-workspace-view";
import type { CodexReply } from "./codex-interaction";

const invalid = () => new Error("自有连接或原生操作回执未确认；不会自动重试");
const id = (v: unknown): v is string =>
  typeof v === "string" && /^[A-Za-z0-9_.:/-]{1,200}$/.test(v);
const native = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v);
function checkedScope(v: unknown): CodexAcpScope {
  const s = v as CodexAcpScope;
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
    ].every(id) ||
    !Number.isSafeInteger(s.generation) ||
    s.generation < 1 ||
    Object.keys(s).length !== 8
  )
    throw invalid();
  return { ...s };
}
function checkedContext(v: unknown): CodexAcpContext {
  const c = v as CodexAcpContext;
  if (
    !c ||
    !id(c.farfoldSessionId) ||
    !id(c.hostTurnId) ||
    !id(c.workingCopyId) ||
    !c.thread ||
    !native(c.thread.nativeThreadId) ||
    !native(c.thread.nativeSessionId) ||
    typeof c.thread.cwd !== "string" ||
    typeof c.thread.status !== "string" ||
    typeof c.thread.cliVersion !== "string" ||
    typeof c.thread.modelProvider !== "string" ||
    (c.thread.path !== null && typeof c.thread.path !== "string") ||
    Object.keys(c).length !== 4 ||
    Object.keys(c.thread).length !== 7
  )
    throw invalid();
  return { ...c, thread: { ...c.thread } };
}

async function operation(
  input: Record<string, unknown>,
  kind: string,
): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = await invoke("host_codex_acp_operation", { input });
  } catch {
    throw invalid();
  }
  if (
    !raw ||
    typeof raw !== "object" ||
    (raw as { kind?: unknown }).kind !== kind
  )
    throw invalid();
  return raw as Record<string, unknown>;
}

/** First owned launch creates the profile; a persisted profile restores exactly. */
export async function requestCodexAcpConnect(input: {
  installationId: string;
  workingCopyId: string;
}): Promise<CodexAcpScope> {
  if (!id(input.installationId) || !id(input.workingCopyId)) throw invalid();
  const raw = await operation(
    {
      action: "connect",
      installationId: input.installationId,
      workingCopyId: input.workingCopyId,
    },
    "connected",
  );
  return checkedScope(raw.scope);
}

/** Stop the current owned connection. Never settles or retries native work. */
export async function requestCodexAcpStop(
  scope: CodexAcpScope,
): Promise<CodexAcpScope> {
  const original = checkedScope(scope);
  const raw = await operation({ action: "stop", scope: original }, "stopped");
  const stopped = checkedScope(raw.scope);
  if (!sameCodexAcpScope(stopped, original)) throw invalid();
  return stopped;
}

/** Reply to the registered native interaction; the key is Host-issued. */
export async function requestCodexAcpInteract(
  scope: CodexAcpScope,
  key: string,
  reply: CodexReply,
): Promise<void> {
  const original = checkedScope(scope);
  if (!id(key)) throw invalid();
  if (
    !reply ||
    (reply.type === "decision" && Object.keys(reply).length !== 2) ||
    (reply.type === "answers" &&
      (Object.keys(reply).length !== 2 ||
        Object.entries(reply.answers).some(
          ([k, v]) => !id(k) || !Array.isArray(v) || v.some((s) => !id(s)),
        ))) ||
    (reply.type !== "decision" && reply.type !== "answers")
  )
    throw invalid();
  await operation(
    { action: "interact", scope: original, key, reply },
    "replied",
  );
}

/** Steer the active native Turn. Acceptance is not execution evidence. */
export async function requestCodexAcpSteer(
  scope: CodexAcpScope,
  context: CodexAcpContext,
  nativeTurnId: string,
  operationId: string,
  text: string,
): Promise<void> {
  const original = checkedScope(scope);
  const checked = checkedContext(context);
  if (
    !id(nativeTurnId) ||
    !id(operationId) ||
    operationId.length > 128 ||
    !text.trim() ||
    new TextEncoder().encode(text).length > 65536
  )
    throw invalid();
  await operation(
    {
      action: "steer",
      scope: original,
      context: checked,
      nativeTurnId,
      operationId,
      text,
    },
    "steered",
  );
}
