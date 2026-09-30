import { memo, useState, type ReactNode } from "react";
import { CaretDown, Check, Copy, Paperclip } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { messageLink } from "../runtime/message-link";
import type { Attachment } from "../runtime/session_types";
import { attachmentMedia } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as A } from "../runtime/message_attachment_strings";
import "../message-attachments.css";

export function MessageAttachments({
  attachments,
}: {
  attachments: readonly Attachment[];
}) {
  if (!attachments.length) return null;
  return (
    <div
      className="message-attachments"
      role="group"
      aria-label={A.label}
      onKeyDown={(event) => {
        // Native summary/media keys belong to this attachment, never to a
        // pending approval in the conversation behind it.
        if (event.key === "Enter" || event.key === "Backspace")
          event.stopPropagation();
      }}
    >
      {attachments.map((attachment, index) => {
        const media = attachmentMedia(attachment);
        return (
          <details className="message-attachment" key={index}>
            <summary title={attachment.uri ?? attachment.name}>
              <Paperclip size={14} aria-hidden="true" />
              <span className="message-attachment-name">{attachment.name}</span>
              <CaretDown
                className="message-attachment-chevron"
                size={12}
                aria-hidden="true"
              />
            </summary>
            <figure className="message-attachment-content">
              <figcaption>
                <ResultLink href={attachment.uri}>{attachment.name}</ResultLink>
                {attachment.mimeType && <small> · {attachment.mimeType}</small>}
              </figcaption>
              {media?.kind === "image" && (
                <img src={media.src} alt={attachment.name} />
              )}
              {media?.kind === "audio" && (
                <audio controls preload="none" src={media.src}>
                  {A.audioUnavailable}
                </audio>
              )}
              {attachment.uri && (
                <div className="message-file-link">{attachment.uri}</div>
              )}
              {attachment.text !== undefined && <pre>{attachment.text}</pre>}
              {!media && attachment.data && <p>{A.previewUnavailable}</p>}
            </figure>
          </details>
        );
      })}
    </div>
  );
}

function ResultLink({
  href,
  children,
}: {
  href?: string;
  children?: ReactNode;
}) {
  const link = messageLink(href);
  if (link.kind === "web")
    return (
      <a href={link.url} target="_blank" rel="noreferrer noopener">
        {children}
      </a>
    );
  // File links render inert until the artifact pane (slice D) wires them up.
  return <span className="message-file-link">{children}</span>;
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

// A thread switch remounts its view. Keep only derived Markdown for the lifetime
// of the source message; streaming replaces this entry rather than retaining chunks.
const parsedMessages = new WeakMap<object, { text: string; tree: ReactNode }>();

function messageTree(source: object, text: string): ReactNode {
  const cached = parsedMessages.get(source);
  if (cached?.text === text) return cached.tree;
  // react-markdown's synchronous export parses and returns an element tree; it
  // has no hooks. Component state (e.g. copy feedback) still belongs to React.
  const tree = ReactMarkdown({
    children: text,
    remarkPlugins: [remarkGfm],
    urlTransform: (url, key) =>
      key !== "href"
        ? defaultUrlTransform(url)
        : messageLink(url).kind === "unavailable"
          ? undefined
          : url,
    components: {
      pre: CodeBlock,
      a: ({ children, href }) => (
        <ResultLink href={href}>{children}</ResultLink>
      ),
    },
  });
  parsedMessages.set(source, { text, tree });
  return tree;
}

export const MessageContent = memo(function MessageContent({
  source,
  text,
  attachments = [],
}: {
  source: object;
  text: string;
  attachments?: readonly Attachment[];
}) {
  return (
    <div className="message-text markdown-body">
      {messageTree(source, text)}
      <MessageAttachments attachments={attachments} />
    </div>
  );
});
