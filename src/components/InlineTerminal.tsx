import { Channel } from "@tauri-apps/api/core";
import { useEffect, useRef } from "react";
import {
  ptyAwait,
  ptyClose,
  ptyResize,
  ptyWrite,
  type PtyChunk,
} from "../runtime/agents";
import { STRINGS } from "../runtime/strings";

export interface InlineTerminalProps {
  /** Starts the PTY: receives the output channel, resolves with the pty id. */
  start: (onOutput: Channel<PtyChunk>) => Promise<string>;
  /** Called once the child exits (after `pty_await` resolves). */
  onExit?: (code: number) => void;
}

function decodeChunk(base64: string): Uint8Array {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Embedded xterm.js view of one backend PTY session. The xterm modules load
 * lazily so the rest of the UI (and node-side tests) never touches DOM-heavy
 * code it does not need. Used by terminal-style login now; the artifact pane
 * reuses it later.
 */
export function InlineTerminal({ start, onExit }: InlineTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  // A terminal session runs once per mount; callback identity changes must
  // not respawn the PTY.
  const startRef = useRef(start);
  const onExitRef = useRef(onExit);
  startRef.current = start;
  onExitRef.current = onExit;

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let ptyId: string | null = null;
    let observer: ResizeObserver | null = null;

    const run = async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed || !hostRef.current) return;

      const term = new Terminal({
        fontSize: 12,
        cursorBlink: true,
        scrollback: 2000,
        convertEol: true,
        theme: {
          background: "#1d1d1a",
          foreground: "#eae6dc",
          cursor: "#eae6dc",
        },
      });
      const fit = new FitAddon();
      term.loadAddon(fit);
      term.open(host);
      fit.fit();
      host.scrollIntoView({ block: "nearest" });

      const channel = new Channel<PtyChunk>();
      channel.onmessage = (chunk) => {
        if (typeof chunk.data === "string") {
          term.write(decodeChunk(chunk.data));
        }
      };

      const id = await startRef.current(channel);
      if (disposed) {
        void ptyClose(id).catch(() => undefined);
        return;
      }
      ptyId = id;
      host.scrollIntoView({ block: "end" });

      term.onData((data) => {
        void ptyWrite(id, data).catch(() => undefined);
      });
      void ptyResize(id, term.cols, term.rows).catch(() => undefined);

      observer = new ResizeObserver(() => {
        try {
          fit.fit();
          if (ptyId) {
            void ptyResize(ptyId, term.cols, term.rows).catch(() => undefined);
          }
        } catch {
          // Fit can throw while the host is hidden; next resize retries.
        }
      });
      observer.observe(host);

      const code = await ptyAwait(id).catch(() => 1);
      if (!disposed) {
        term.writeln(
          `\r\n${
            code === 0
              ? STRINGS.agents.auth.terminalDone
              : STRINGS.agents.auth.terminalFailed(code)
          }`,
        );
      }
      onExitRef.current?.(code);
    };

    void run().catch(() => {
      onExitRef.current?.(1);
    });

    return () => {
      disposed = true;
      observer?.disconnect();
      if (ptyId) void ptyClose(ptyId).catch(() => undefined);
      host.replaceChildren();
    };
    // Run once per mount: refs above carry the latest callbacks.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <div className="inline-term" ref={hostRef} />;
}
