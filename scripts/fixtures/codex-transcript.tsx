import { useState } from "react";
import { createRoot } from "react-dom/client";
import { mockIPC } from "@tauri-apps/api/mocks";
import { CodexTranscript } from "../../src/components/CodexTranscript";
import { useCodexAcpWorkspace } from "../../src/runtime/use-codex-acp-workspace";
import { codexConversation } from "../../src/runtime/codex-conversation";
import {
  contentBinding,
  contentSnapshot,
  contentHistory,
  contentContext,
  contentNativeTurn,
  contentEvent,
  contentBatch,
} from "./codex-transcript-data";
import type { AcpHistory } from "../../src/runtime/codex-acp-content";
import type { HostRoutedEvent } from "../../src/runtime/host-shadow";
import "../../src/styles.css";

// Static-only full IPC interception. Controls modify synthetic observations, never native work.
let active = false,
  connected = true,
  generation = 1,
  sequence = 0,
  gap = false,
  delay = false;
let events: HostRoutedEvent[] = [];
let release: (() => void) | null = null;
let finished = false;
const audit: { command: string; action?: string }[] = [];
function observed(id: string) {
  const s = contentSnapshot();
  s.scope!.generation = generation;
  s.target!.farfoldSessionId = id;
  if (id !== contentBinding.farfoldSessionId)
    s.target!.nativeThreadId = "019a0000-0000-7000-8000-000000000003";
  s.connectionState = connected ? "connected" : "unknown";
  if (active && id === contentBinding.farfoldSessionId)
    s.activeTurn = {
      context: contentContext(),
      nativeTurnId: contentNativeTurn,
      stopRequested: false,
    };
  return s;
}
function historical(id: string): AcpHistory {
  const h = contentHistory();
  h.scope.generation = generation;
  h.farfoldSessionId = id;
  h.nativeThreadId = observed(id).target!.nativeThreadId;
  h.before.latestSequence = sequence;
  h.turns = [
    {
      nativeTurnId: "019a0000-0000-7000-8000-000000000009",
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "history-message",
          text:
            id === contentBinding.farfoldSessionId
              ? `原会话历史 · 第 ${generation} 代`
              : "OTHER SESSION CONTENT",
        },
        {
          type: "commandExecution",
          id: "history-command",
          status: "completed",
        },
      ],
    },
  ];
  if (finished && id === contentBinding.farfoldSessionId)
    h.turns.push({
      nativeTurnId: contentNativeTurn,
      status: "completed",
      items: [
        {
          type: "agentMessage",
          id: "live-message",
          text: "实时输出已完成；这是终态历史中的最终正文。",
        },
        {
          type: "reasoning",
          id: "reasoning",
          summary: ["合成安全推理摘要"],
          content: [],
        },
      ],
    });
  return h;
}
function append(payload: Record<string, unknown>) {
  const e = contentEvent(++sequence, payload);
  (e.nativeEnvelope as any).payload.params.scope.generation = generation;
  e.runtimeGeneration = generation;
  events.push(e);
}
mockIPC(async (command, args = {}) => {
  const input = args.input as any;
  audit.push({ command, action: input?.action });
  const el = document.getElementById("audit");
  if (el) el.textContent = JSON.stringify(audit.slice(-12), null, 2);
  if (command === "host_codex_acp_workspace")
    return observed(String(args.farfoldSessionId));
  if (command === "host_codex_acp_operation" && input?.action === "history") {
    if (active) throw new Error("Synthetic history busy");
    const h = historical(input.farfoldSessionId);
    if (delay) {
      delay = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return { kind: "history", snapshot: h };
  }
  if (command === "runtime_event_snapshot") {
    const after = Number(args.afterSequence),
      filtered = events.filter((e) => e.sequence > after);
    return {
      ...contentBatch(after, filtered),
      latestSequence: sequence,
      nextAfter: filtered.at(-1)?.sequence ?? after,
      gap:
        gap && filtered.length
          ? {
              requestedAfter: after,
              oldestAvailable: filtered[0].sequence,
              latestSequence: sequence,
              droppedTotal: 3,
            }
          : null,
    };
  }
  throw new Error(`Not available in read-only fixture: ${command}`);
});
function ReadOnly({ other }: { other: boolean }) {
  const b = other
    ? {
        ...contentBinding,
        farfoldSessionId: "other",
        nativeSessionId: "019a0000-0000-7000-8000-000000000003",
      }
    : contentBinding;
  const state = useCodexAcpWorkspace(true, b);
  return (
    <>
      <p role="status">{state?.error ?? "只读合成验证；所有产品操作仍关闭"}</p>
      <CodexTranscript
        conversation={codexConversation()}
        acp={state?.transcript}
        session={b}
        summary={state?.transcript?.notice ?? "读取中"}
      />
      <button disabled>发送</button>
      <button disabled>Stop</button>
      <button disabled>回复 / 插话</button>
    </>
  );
}
function App() {
  const [open, setOpen] = useState(true),
    [other, setOther] = useState(false);
  return (
    <div className="app-shell">
      <aside className="sidebar" style={{ padding: 16, overflow: "auto" }}>
        <h2>只读正文夹具</h2>
        <button
          onClick={() => {
            active = true;
            finished = false;
            append({ kind: "started" });
            append({
              kind: "item_started",
              item: { type: "agentMessage", id: "live-message", text: "" },
            });
            append({
              kind: "delta",
              itemId: "live-message",
              channel: "item/agentMessage/delta",
              delta: "实时输出正在继续。",
              index: null,
            });
            append({
              kind: "item_started",
              item: {
                type: "reasoning",
                id: "reasoning",
                summary: [],
                content: [],
              },
            });
            append({
              kind: "delta",
              itemId: "reasoning",
              channel: "item/reasoning/summaryTextDelta",
              delta: "合成安全推理摘要",
              index: 0,
            });
          }}
        >
          合成活动输出
        </button>
        <button
          onClick={() => {
            append({
              kind: "item_completed",
              item: {
                type: "agentMessage",
                id: "live-message",
                text: "实时输出已完成；这是终态历史中的最终正文。",
              },
            });
            append({ kind: "terminal", status: "completed" });
            active = false;
            finished = true;
          }}
        >
          合成终态
        </button>
        <button
          onClick={() => {
            sequence += 3;
            events = [];
            gap = true;
            append({
              kind: "delta",
              itemId: "live-message",
              channel: "item/agentMessage/delta",
              delta: " 缺口后的片段。",
              index: null,
            });
          }}
        >
          制造事件缺口
        </button>
        <button
          onClick={() => {
            connected = !connected;
          }}
        >
          切换连接未知
        </button>
        <button onClick={() => setOpen((v) => !v)}>
          {open ? "关闭正文" : "返回正文"}
        </button>
        <button onClick={() => setOther((v) => !v)}>切换 Session</button>
        <button
          onClick={() => {
            delay = true;
            setOpen(false);
          }}
        >
          延迟下次历史并关闭
        </button>
        <button
          onClick={() => {
            release?.();
            release = null;
          }}
        >
          释放旧历史
        </button>
        <button
          onClick={() => {
            generation++;
            active = false;
            finished = false;
          }}
        >
          换代
        </button>
        <details>
          <summary>只读 IPC 审计</summary>
          <pre id="audit" />
        </details>
      </aside>
      <main
        className="workspace"
        style={{ padding: 24, overflow: "auto", display: "block" }}
      >
        {open ? (
          <ReadOnly other={other} />
        ) : (
          <p>正文已关闭，未发送停止请求。</p>
        )}
      </main>
    </div>
  );
}
const root = createRoot(document.getElementById("root")!);
root.render(<App />);
import.meta.hot?.dispose(() => root.unmount());
