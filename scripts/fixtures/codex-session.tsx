import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CodexAcpSessionStart } from "../../src/components/CodexAcpSessionStart";
import { useHostSessionDraft } from "../../src/runtime/host-draft";
import { closedCodexAcpWorkspace } from "../../src/runtime/codex-acp-workspace";
import type { HostSessionBinding } from "../../src/runtime/host-shadow";
import "../../src/styles.css";
// Static browser fixture only. Every IPC is intercepted; no production flag or native use.
let generation = 1;
const scope = () => ({
  runtimeProductId: "codex",
  installationId: "install",
  runtimeBuildId: "build",
  adapterId: "codex-acp-stdio-v1",
  adapterBuildId: "adapter",
  connectionId: "conn",
  profileId: "profile",
  generation,
});
const selection = {
  catalogModelId: "picker",
  nativeModel: "native-model",
  provider: "fixture",
  reasoningEffort: "medium",
};
const nativeThreadId = "019a0000-0000-7000-8000-000000000001";
const nativeTreeId = "019a0000-0000-7000-8000-000000000002";
const saved: HostSessionBinding = {
  farfoldSessionId: "saved",
  nativeSessionId: nativeThreadId,
  runtimeProductId: "codex",
  installationId: "install",
  adapterId: "codex-acp-stdio-v1",
  runtimeBuildId: "build",
  connectionId: "conn",
  projectId: "project",
  projectPath: "/fixture",
  projectName: "Fixture",
  workingCopyId: "work",
  workingCopyPath: "/fixture",
  workingCopyKind: "root",
  branchName: null,
  nativeLocatorRegistered: true,
  title: "原 ACP Session",
  titleSource: "native",
  pinned: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1,
  unreviewedChangeCount: 0,
};
const other = {
  ...saved,
  farfoldSessionId: "other",
  nativeSessionId: "019a0000-0000-7000-8000-000000000003",
  title: "另一 Session",
};
const rows = [saved, other];
const drafts = new Map([
  ["saved", "SAVED DRAFT"],
  ["other", "OTHER DRAFT"],
]);
const navigation = () => ({
  sessionIndex: { schemaVersion: 15, sessions: rows },
  restoreState: { lastProjectId: "project", lastSessionId: null, updatedAt: 1 },
});
const audit: { command: string; action?: string; session?: string }[] = [];
let navigationRevision = 0;
let navigationSession = "other";
const navigationExpectation = () =>
  navigationRevision === 0
    ? { kind: "absent" }
    : {
        kind: "present",
        lastProjectId: "project",
        lastSessionId: navigationSession,
        updatedAt: navigationRevision,
      };
let delay = false,
  fail = false,
  badBinding = false;
let release: (() => void) | null = null;
mockIPC(async (command, args = {}) => {
  const input = args.input as any;
  audit.push({
    command,
    action: input?.command?.action ?? input?.action,
    session: args.farfoldSessionId as string | undefined,
  });
  document.getElementById("audit")!.textContent = JSON.stringify(
    audit,
    null,
    2,
  );
  if (command === "codex_installation_list")
    return [
      {
        installationId: "install",
        runtimeBuildId: "build",
        inspection: { version: "0.143.0" },
      },
    ];
  if (command === "working_copy_snapshot")
    return {
      workingCopies: [
        {
          workingCopyId: "work",
          projectId: "project",
          canonicalPath: "/fixture",
          pathState: "ready",
          managedState: null,
          removalState: null,
        },
      ],
      observedAt: 1,
    };
  if (command === "host_codex_acp_session_context")
    return {
      scope: scope(),
      projectId: "project",
      workingCopyId: "work",
      cwd: "/fixture",
      navigationExpectation: navigationExpectation(),
    };
  if (command === "host_codex_acp_operation") {
    if (input.action === "focus") {
      if (
        JSON.stringify(input.expectedNavigation) !==
        JSON.stringify(navigationExpectation())
      )
        throw new Error("Synthetic navigation conflict");
      navigationRevision++;
      navigationSession = input.receipt.farfoldSessionId;
      return {
        kind: "focused",
        scope: input.receipt.scope,
        farfoldSessionId: input.receipt.farfoldSessionId,
        navigation: {
          ...navigation(),
          restoreState: {
            lastProjectId: "project",
            lastSessionId: input.receipt.farfoldSessionId,
            updatedAt: navigationRevision,
          },
        },
      };
    }
    if (input.action === "admission")
      return {
        kind: "admission",
        snapshot: {
          scope: input.scope,
          epoch: 1,
          catalogHash: "a".repeat(64),
          account: { kind: "apiKey", requiresOpenaiAuth: true },
          selection:
            input.command.action === "select" ? input.command.selection : null,
          catalog: [
            {
              id: "picker",
              model: "native-model",
              displayName: "Synthetic model",
              description: "",
              hidden: false,
              isDefault: true,
              supportedReasoningEfforts: [
                { reasoningEffort: "medium", description: "" },
                { reasoningEffort: "high", description: "" },
              ],
              defaultReasoningEffort: "medium",
              inputModalities: ["text"],
            },
          ],
        },
      };
    if (input.action !== "session") throw new Error("Unexpected operation");
    const id =
      input.command.action === "open"
        ? input.command.farfoldSessionId
        : "created";
    const row = rows.find((r) => r.farfoldSessionId === id) ?? {
      ...saved,
      farfoldSessionId: id,
      title: "新 ACP Session",
    };
    if (!rows.includes(row)) rows.push(row);
    const result = {
      kind: "session",
      snapshot: {
        scope: input.scope,
        farfoldSessionId: id,
        workingCopyId: "work",
        nativeThreadId: row.nativeSessionId,
        nativeTreeId,
        selection,
      },
    };
    if (delay) {
      delay = false;
      await new Promise<void>((r) => {
        release = r;
      });
    }
    if (fail) {
      fail = false;
      throw new Error("Synthetic unknown");
    }
    return result;
  }
  if (command === "host_navigation_snapshot")
    return badBinding
      ? {
          ...navigation(),
          sessionIndex: {
            schemaVersion: 15,
            sessions: rows.map((r) => ({ ...r, workingCopyId: "foreign" })),
          },
        }
      : navigation();
  if (command === "host_session_focus")
    throw new Error("ACP must use guarded focus");
  if (command === "host_codex_acp_workspace") {
    const row = rows.find((r) => r.farfoldSessionId === args.farfoldSessionId)!;
    return {
      ...closedCodexAcpWorkspace(),
      scope: scope(),
      connectionState: "connected",
      target: {
        farfoldSessionId: row.farfoldSessionId,
        runtime: {
          productId: "codex",
          installationId: "install",
          runtimeBuildId: "build",
          adapterId: saved.adapterId,
          connectionId: "conn",
        },
        workingCopyId: "work",
        cwd: "/fixture",
        nativeThreadId: row.nativeSessionId,
        nativeTreeId,
      },
      admission: {
        scope: scope(),
        epoch: 1,
        account: { kind: "apiKey", requiresOpenaiAuth: true },
        catalog: null,
        catalogHash: null,
        selection,
        actual: {
          ...selection,
          nativeThreadId: row.nativeSessionId,
          nativeSessionId: nativeTreeId,
        },
      },
    };
  }
  if (command === "session_draft_get")
    return {
      farfoldSessionId: args.farfoldSessionId,
      body: drafts.get(args.farfoldSessionId as string) ?? "",
      updatedAt: 1,
    };
  if (command === "session_draft_set") {
    drafts.set(input.farfoldSessionId, input.body);
    return { ...input, updatedAt: 1 };
  }
  if (command === "session_draft_clear") {
    drafts.delete(args.farfoldSessionId as string);
    return null;
  }
  throw new Error(`Unexpected IPC: ${command}`);
});
function Fixture() {
  const [binding, setBinding] = useState<HostSessionBinding | null>(null);
  const [path, setPath] = useState("/fixture");
  const [epoch, setEpoch] = useState(0);
  const [activated, setActivated] = useState("none");
  const [draft, setDraft] = useHostSessionDraft(
    binding?.farfoldSessionId ?? null,
    () => undefined,
  );
  const reset = (b: HostSessionBinding | null) => {
    setBinding(b);
    setPath("/fixture");
    setEpoch((e) => e + 1);
  };
  return (
    <>
      <nav>
        <button
          onClick={() => {
            navigationRevision++;
            navigationSession = "other";
          }}
        >
          提交另一导航
        </button>
        <button onClick={() => reset(null)}>新建视图</button>
        <button onClick={() => reset(saved)}>原会话视图</button>
        <button onClick={() => reset(other)}>切换另一会话</button>
        <button
          onClick={() => {
            generation++;
            setEpoch((e) => e + 1);
          }}
        >
          换代
        </button>
        <button
          onClick={() => {
            delay = true;
          }}
        >
          延迟下次 Session
        </button>
        <button
          onClick={() => {
            release?.();
            release = null;
          }}
        >
          释放回执
        </button>
        <button
          onClick={() => {
            fail = true;
          }}
        >
          下次失败
        </button>
        <button
          onClick={() => {
            badBinding = !badBinding;
          }}
        >
          切换绑定冲突
        </button>
        <button onClick={() => setPath("/foreign")}>切换项目</button>
      </nav>
      <p id="activated">已激活：{activated}</p>
      <textarea
        aria-label="Session 草稿"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
      />
      <div className="app-shell">
        <main className="workspace" style={{ gridColumn: "1 / -1" }}>
          <div className="conversation-scroll">
            <CodexAcpSessionStart
              key={JSON.stringify([binding?.farfoldSessionId, path, epoch])}
              binding={binding}
              projectPath={path}
              chooseProject={() => setPath("/foreign")}
              allowed
              current={() => true}
              onActivated={(b) => {
                setActivated(b.farfoldSessionId);
                setBinding(b);
              }}
            />
          </div>
        </main>
      </div>
      <details>
        <summary>生产关闭对照</summary>
        <CodexAcpSessionStart
          binding={null}
          projectPath="/fixture"
          chooseProject={() => undefined}
          allowed={false}
          current={() => true}
          onActivated={() => {
            throw new Error("Production activation");
          }}
        />
      </details>
      <pre id="audit" />
    </>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<Fixture />);
import.meta.hot?.dispose(() => root.unmount());
