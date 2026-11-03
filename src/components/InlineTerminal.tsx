import { useEffect, useRef, useState } from "react";
import { ptyResize, ptyWrite } from "../runtime/agents";
import { STRINGS } from "../runtime/strings";
import type { BufferedLoginTerminal } from "../runtime/login_terminal";
import { uiError } from "../runtime/ui_error";
import { AUTH_ACTIVITY_STRINGS } from "../runtime/auth_strings";
import { PREPARATION_ACTION_STRINGS as C } from "../runtime/preparation_action_strings";

function decodeChunk(base64: string): Uint8Array {
  return Uint8Array.from(window.atob(base64), (character) =>
    character.charCodeAt(0),
  );
}

/** The view subscribes to an existing terminal. Unmount only detaches rendering. */
export function InlineTerminal({
  session,
  purpose = "authentication",
  getFinishRequested,
}: {
  session: BufferedLoginTerminal;
  purpose?: "authentication" | "service_configuration";
  getFinishRequested?: () => boolean;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const finishRequested = useRef(getFinishRequested);
  finishRequested.current = getFinishRequested;
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let disposed = false;
    let cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }] = await Promise.all([
        import("@xterm/xterm"),
        import("@xterm/addon-fit"),
      ]);
      if (disposed) return;
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
      let sequence = 0;
      let showedExit = false;
      let resizedId: string | null = null;
      const fitTerminal = () => {
        try {
          fit.fit();
          const id = session.getSnapshot().id;
          if (id)
            void ptyResize(id, term.cols, term.rows).catch(() => undefined);
        } catch {
          /* Hidden terminal will fit when shown again. */
        }
      };
      const render = () => {
        if (disposed) return;
        const value = session.getSnapshot();
        if (value.id && value.id !== resizedId) {
          resizedId = value.id;
          void ptyResize(value.id, term.cols, term.rows).catch(() => undefined);
        }
        // Parsing can immediately emit a terminal response. Keep early output
        // buffered until the response has a terminal ID to write back to.
        if (value.id) {
          for (const chunk of value.output) {
            if (chunk.sequence > sequence) {
              term.write(decodeChunk(chunk.data));
              sequence = chunk.sequence;
            }
          }
        }
        if (value.exit !== null && !showedExit) {
          showedExit = true;
          term.writeln(
            `\r\n${
              finishRequested.current?.()
                ? AUTH_ACTIVITY_STRINGS.finishEnded
                : purpose === "service_configuration"
                  ? value.exit === 0
                    ? C.ended
                    : value.cancelled
                      ? C.cancelled
                      : C.exitFailed(value.exit)
                  : value.exit === 0
                    ? STRINGS.agents.auth.terminalDone
                    : value.cancelled
                      ? AUTH_ACTIVITY_STRINGS.cancelled
                      : STRINGS.agents.auth.terminalFailed(value.exit)
            }`,
          );
        }
        setError(
          value.error
            ? uiError(value.error, STRINGS.agents.auth.closeFailed)
            : null,
        );
      };
      const unsubscribe = session.subscribe(render);
      const input = term.onData((data) => {
        const value = session.getSnapshot();
        if (value.id && value.exit === null && !value.closing)
          void ptyWrite(value.id, data).catch((reason) =>
            setError(
              uiError(
                reason,
                purpose === "service_configuration"
                  ? C.failed
                  : STRINGS.agents.auth.failed,
              ),
            ),
          );
      });
      const observer = new ResizeObserver(fitTerminal);
      observer.observe(host);
      render();
      fitTerminal();
      term.focus();
      cleanup = () => {
        unsubscribe();
        observer.disconnect();
        input.dispose();
        term.dispose();
        host.replaceChildren();
      };
    })().catch(() => {
      if (!disposed)
        setError(
          purpose === "service_configuration"
            ? C.failed
            : STRINGS.agents.auth.failed,
        );
    });
    return () => {
      disposed = true;
      cleanup();
    };
  }, [session, purpose]);
  return (
    <>
      <div className="inline-term" ref={hostRef} />
      {error && (
        <div className="auth-note" role="alert">
          {error}
          <button
            className="btn btn-text"
            onClick={() => void session.close().catch(() => undefined)}
          >
            {STRINGS.agents.auth.retryClose}
          </button>
        </div>
      )}
    </>
  );
}
