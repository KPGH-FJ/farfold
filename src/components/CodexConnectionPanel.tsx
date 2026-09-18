import {
  CodexConfigureSection,
  type CodexConfigurePresentation,
} from "./CodexConfigureSection";

// ACP configure only. The retired Direct connection/account controls are gone;
// no fallback to the old transport exists for any Codex binding.
export function CodexConnectionPanel({
  acp,
}: {
  acp: CodexConfigurePresentation;
}) {
  const { scope, viewKey, port } = acp;
  return (
    <section
      className="codex-installation-result"
      aria-label="Codex 连接与账号"
    >
      <h3>连接与账号</h3>
      {scope && port.allowed ? (
        <CodexConfigureSection
          key={JSON.stringify([viewKey, scope, port.allowed])}
          scope={scope}
          port={port}
        />
      ) : (
        <p role="status">自有连接未就绪；不会启动登录或读取凭据。</p>
      )}
    </section>
  );
}
