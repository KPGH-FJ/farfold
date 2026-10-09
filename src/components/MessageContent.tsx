import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import {
  createContext,
  memo,
  useContext,
  useState,
  useId,
  type ReactNode,
} from "react";
import { CaretDown, Check, Copy, Paperclip } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { inlineFilePath, messageLink } from "../runtime/message-link";
import type { Attachment } from "../runtime/session_types";
import { attachmentMedia } from "../runtime/message_attachments";
import { MESSAGE_ATTACHMENTS as A } from "../runtime/message_attachment_strings";
import { THREAD_VIEW_STRINGS } from "../runtime/thread_view_strings";
import "../message-attachments.css";
import { useSearchExpansion } from "./transcript-search";

export type OpenMessageFile = (path: string, opener: HTMLElement) => void;
const FileOpenContext = createContext<OpenMessageFile | null>(null);

/** Consumes current navigation context even when the Markdown tree is cached. */
export function MessageFileLink({
  path,
  children,
  onOpenFile: provided,
}: {
  path: string;
  children?: ReactNode;
  onOpenFile?: OpenMessageFile;
}) {
  const inherited = useContext(FileOpenContext);
  const onOpenFile = provided ?? inherited;
  if (!onOpenFile) return <span className="message-file-link">{children}</span>;
  return (
    <button
      type="button"
      className="message-file-link message-file-button"
      title={path}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onOpenFile(path, event.currentTarget);
      }}
      onKeyDown={(event) => {
        if (["Enter", " ", "Backspace"].includes(event.key))
          event.stopPropagation();
      }}
    >
      <FileOpenContext.Provider value={null}>
        {children}
      </FileOpenContext.Provider>
    </button>
  );
}

function InlineFileCode({
  children,
  className,
}: {
  children?: ReactNode;
  className?: string;
}) {
  const onOpenFile = useContext(FileOpenContext);
  const path = typeof children === "string" ? inlineFilePath(children) : null;
  const code = <code className={className}>{children}</code>;
  return onOpenFile && path ? (
    <MessageFileLink path={path}>{code}</MessageFileLink>
  ) : (
    code
  );
}

export function MessageAttachments({
  attachments,
  onOpenFile,
}: {
  attachments: readonly Attachment[];
  onOpenFile?: OpenMessageFile;
}) {
  const expansion = useSearchExpansion();
  const listId = useId();
  if (!attachments.length) return null;
  const content = (
    <div
      className="message-attachments"
      ref={expansion.ref}
      data-find-exclude-children
      role="group"
      aria-label={A.label}
      onKeyDown={(event) => {
        // Native summary/media keys belong to this attachment, never to a
        // pending approval in the conversation behind it.
        if (event.key === "Enter" || event.key === "Backspace")
          event.stopPropagation();
      }}
    >
      {attachments.length > 3 && (
        <button
          type="button"
          className="message-attachments-toggle"
          aria-expanded={expansion.open}
          aria-controls={listId}
          onClick={expansion.toggle}
        >
          {expansion.open
            ? R.collapseAttachments
            : R.expandAttachments(attachments.length)}
        </button>
      )}
      <div id={listId}>
        {(expansion.materialized ? attachments : attachments.slice(0, 3)).map(
          (attachment, index) => (
            <div key={index} hidden={index >= 3 && !expansion.open}>
              <MessageAttachment attachment={attachment} />
            </div>
          ),
        )}
      </div>
    </div>
  );
  return onOpenFile ? (
    <FileOpenContext.Provider value={onOpenFile}>
      {content}
    </FileOpenContext.Provider>
  ) : (
    content
  );
}

function MessageAttachment({ attachment }: { attachment: Attachment }) {
  const expansion = useSearchExpansion();
  // Search may reveal loaded text, but only the user's own expansion admits media.
  const media = expansion.userOpen ? attachmentMedia(attachment) : null;
  const mediaWaiting =
    !expansion.userOpen &&
    !!attachment.data &&
    /^(image|audio)\//.test(attachment.mimeType ?? "");
  return (
    <details
      className="message-attachment"
      ref={expansion.ref}
      open={expansion.open}
      onToggle={expansion.onToggle}
    >
      <summary title={attachment.uri ?? attachment.name}>
        <Paperclip size={14} aria-hidden="true" />
        <span className="message-attachment-name" data-find-block>
          {messageLink(attachment.uri).kind === "file" ? (
            <MessageResultLink href={attachment.uri}>
              {attachment.name}
            </MessageResultLink>
          ) : (
            attachment.name
          )}
        </span>
        <CaretDown
          className="message-attachment-chevron"
          size={12}
          aria-hidden="true"
        />
      </summary>
      <figure className="message-attachment-content">
        <figcaption>
          <MessageResultLink href={attachment.uri}>
            {attachment.name}
          </MessageResultLink>
          {attachment.mimeType && (
            <small>
              {" "}
              · <span data-find-block>{attachment.mimeType}</span>
            </small>
          )}
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
          <div className="message-file-link" data-find-block>
            {attachment.uri}
          </div>
        )}
        {attachment.text !== undefined && (
          <pre data-find-block>{attachment.text}</pre>
        )}
        {mediaWaiting && (
          <button type="button" onClick={() => expansion.choose(true)}>
            {R.findShowMedia}
          </button>
        )}
        {!mediaWaiting && !media && attachment.data && (
          <p>{A.previewUnavailable}</p>
        )}
      </figure>
    </details>
  );
}

export function MessageResultLink({
  href,
  children,
  onOpenFile,
}: {
  href?: string;
  children?: ReactNode;
  onOpenFile?: OpenMessageFile;
}) {
  const link = messageLink(href);
  if (link.kind === "web")
    return (
      <a href={link.url} target="_blank" rel="noreferrer noopener">
        <FileOpenContext.Provider value={null}>
          {children}
        </FileOpenContext.Provider>
      </a>
    );
  if (link.kind === "file")
    return (
      <MessageFileLink path={link.path} onOpenFile={onOpenFile}>
        {children}
      </MessageFileLink>
    );
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
        aria-label={
          copied ? THREAD_VIEW_STRINGS.copiedCode : THREAD_VIEW_STRINGS.copyCode
        }
      >
        {copied ? <Check size={14} /> : <Copy size={14} />}
        {copied ? THREAD_VIEW_STRINGS.copied : THREAD_VIEW_STRINGS.copy}
      </button>
      <FileOpenContext.Provider value={null}>
        <pre>{children}</pre>
      </FileOpenContext.Provider>
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
      code: InlineFileCode,
      a: ({ children, href }) => (
        <MessageResultLink href={href}>{children}</MessageResultLink>
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
  onOpenFile,
}: {
  source: object;
  text: string;
  attachments?: readonly Attachment[];
  onOpenFile?: OpenMessageFile;
}) {
  return (
    <FileOpenContext.Provider value={onOpenFile ?? null}>
      <div className="message-text markdown-body" data-find-block>
        {messageTree(source, text)}
        <MessageAttachments attachments={attachments} />
      </div>
    </FileOpenContext.Provider>
  );
});
