import { memo, useState, type ReactNode } from "react";
import { Check, Copy } from "@phosphor-icons/react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
}: {
  text: string;
  thinking?: string;
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
          components={{
            pre: CodeBlock,
            a: ({ children, ...props }) => (
              <a {...props} target="_blank" rel="noreferrer noopener">
                {children}
              </a>
            ),
          }}
        >
          {text}
        </ReactMarkdown>
      </div>
    </>
  );
});
