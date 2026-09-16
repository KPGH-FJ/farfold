import { memo, useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { messageLink } from "../runtime/message-link";
import {
  openProjectFile,
  revealProjectFile,
  type ProjectFileSession,
} from "../runtime/project-file-reference";

function ResultLink({
  href,
  children,
  session,
}: {
  href?: string;
  children?: ReactNode;
  session?: ProjectFileSession | null;
}) {
  const [busy, setBusy] = useState<"open" | "reveal" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const link = messageLink(href);
  if (link.kind === "web")
    return (
      <a href={link.url} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  if (link.kind !== "file" || !session)
    return <span title="此链接暂不可打开">{children}</span>;
  const runAction = (action: "open" | "reveal") => {
    setBusy(action);
    setError(null);
    const request =
      action === "open"
        ? openProjectFile(session, link.path)
        : revealProjectFile(session, link.path);
    void request
      .catch((reason) => setError(String(reason)))
      .finally(() => setBusy(null));
  };
  return (
    <>
      <span className="message-file-link">
        <span>{children}</span>
        <button
          type="button"
          disabled={busy !== null}
          title={`打开：${link.path}`}
          onClick={() => runAction("open")}
        >
          {busy === "open" ? "打开中…" : "打开"}
        </button>
        <button
          type="button"
          disabled={busy !== null}
          title={`在访达中显示：${link.path}`}
          onClick={() => runAction("reveal")}
        >
          {busy === "reveal" ? "定位中…" : "定位"}
        </button>
      </span>
      {error && (
        <span role="alert" className="message-link-error">
          {error}
        </span>
      )}
    </>
  );
}

function textFromNode(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) return node.map(textFromNode).join("");
  if (node && typeof node === "object" && "props" in node) {
    return textFromNode((node.props as { children?: ReactNode }).children);
  }
  return "";
}

function CodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const text = textFromNode(children).replace(/\n$/, "");
  return (
    <div className="code-block">
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 1_500);
          });
        }}
        aria-label={copied ? "已复制代码" : "复制代码"}
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? "已复制" : "复制"}
      </button>
      <pre>{children}</pre>
    </div>
  );
}

export const MessageContent = memo(function MessageContent({
  text,
  thinking,
  session,
}: {
  text: string;
  thinking?: string;
  session?: ProjectFileSession | null;
}) {
  return (
    <>
      {thinking && (
        <details className="thinking-block">
          <summary>思考过程</summary>
          <p>{thinking}</p>
        </details>
      )}
      <div className="message-text markdown-body">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          urlTransform={(url, key) =>
            key !== "href"
              ? defaultUrlTransform(url)
              : messageLink(url).kind === "unavailable"
                ? undefined
                : url
          }
          components={{
            pre: CodeBlock,
            a: ({ children, href }) => (
              <ResultLink
                key={`${session?.farfoldSessionId}:${session?.nativeSessionId}:${href}`}
                href={href}
                session={session}
              >
                {children}
              </ResultLink>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </>
  );
});
