import { useEffect, useMemo, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { appendBounded } from "./runtime/event-buffer";
import {
  onPiEvent,
  runtimeStatus,
  sendRpc,
  startRuntime,
  stopRuntime,
  type PiEnvelope,
  type RuntimeStatus,
} from "./runtime/pi";

const initialStatus: RuntimeStatus = {
  running: false,
  projectPath: null,
  sessionDir: null,
  generation: 0,
};

export default function App() {
  const [status, setStatus] = useState(initialStatus);
  const [projectPath, setProjectPath] = useState<string | null>(null);
  const [events, setEvents] = useState<PiEnvelope[]>([]);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;

    void runtimeStatus().then((next) => {
      if (!cancelled) {
        setStatus(next);
        setProjectPath(next.projectPath);
      }
    });

    void onPiEvent((event) => {
      setEvents((current) => appendBounded(current, event, 200));
      if (event.kind === "lifecycle") {
        void runtimeStatus().then(setStatus);
      }
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const latest = useMemo(() => events.slice(-8).reverse(), [events]);

  async function chooseProject() {
    const selected = await open({
      directory: true,
      multiple: false,
      title: "选择 Farfold Project",
    });
    if (typeof selected === "string") setProjectPath(selected);
  }

  async function start() {
    setError(null);
    try {
      const next = await startRuntime(projectPath);
      setStatus(next);
      await sendRpc({ type: "get_state", id: `bootstrap-${next.generation}` });
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function stop() {
    setError(null);
    try {
      setStatus(await stopRuntime());
    } catch (reason) {
      setError(String(reason));
    }
  }

  async function send() {
    const text = message.trim();
    if (!text) return;
    setError(null);
    try {
      await sendRpc({ type: "prompt", message: text });
      setMessage("");
    } catch (reason) {
      setError(String(reason));
    }
  }

  return (
    <main className="shell">
      <header className="titlebar">
        <div>
          <p className="eyebrow">PERSONAL AGENT</p>
          <h1>Farfold</h1>
        </div>
        <span className={status.running ? "status live" : "status"}>
          <i /> {status.running ? "Agent 已连接" : "Agent 未启动"}
        </span>
      </header>

      <section className="workspace-card">
        <div>
          <p className="label">Project</p>
          <p className="project-path">
            {projectPath ?? "尚未选择；启动时将使用 Farfold 本地工作区"}
          </p>
        </div>
        <button
          className="secondary"
          onClick={() => void chooseProject()}
          disabled={status.running}
        >
          选择文件夹
        </button>
      </section>

      <section className="conversation">
        <div className="empty-state">
          <span className="mark">F</span>
          <h2>从一个真实任务开始</h2>
          <p>
            Farfold 使用固定版本的 Pi 运行任务。Project、工具和会话语义由 Pi
            直接负责。
          </p>
        </div>

        {latest.length > 0 && (
          <div className="event-list" aria-live="polite">
            {latest.map((event, index) => (
              <article key={`${events.length}-${index}`}>
                <b>{event.kind}</b>
                <pre>{JSON.stringify(event.payload, null, 2)}</pre>
              </article>
            ))}
          </div>
        )}
      </section>

      {error && <p className="error">{error}</p>}

      <section className="composer">
        <textarea
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              if (status.running) void send();
            }
          }}
          placeholder={
            status.running ? "交给 Farfold 一个任务…" : "先启动 Agent"
          }
          disabled={!status.running}
        />
        <div className="composer-actions">
          {!status.running ? (
            <button className="primary" onClick={() => void start()}>
              启动 Agent
            </button>
          ) : (
            <>
              <button className="secondary" onClick={() => void stop()}>
                停止
              </button>
              <button
                className="primary"
                onClick={() => void send()}
                disabled={!message.trim()}
              >
                发送
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
