import { CONVERSATION_REDESIGN as R } from "../runtime/conversation_redesign_strings";
import {
  createContext,
  memo,
  useContext,
  useState,
  useId,
  useLayoutEffect,
  type ReactNode,
} from "react";
import { CaretDown, Check, Copy, Paperclip } from "@phosphor-icons/react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import { inlineFilePath, messageLink } from "../runtime/message-link";
import type { Attachment } from "../runtime/session_types";
import { useMessageMediaPreview } from "../runtime/use_message_media_budget";
import { MESSAGE_ATTACHMENTS as A } from "../runtime/message_attachment_strings";
import { THREAD_VIEW_STRINGS } from "../runtime/thread_view_strings";
import "../message-attachments.css";
import { MessageAttachmentMedia } from "./MessageAttachmentMedia";
import { useSearchExpansion } from "./transcript-search";
import {
  checkedMessageContentOrder,
  type MessageContentOrderPart,
} from "../runtime/message_content_order";

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
  indexOffset = 0,
}: {
  attachments: readonly Attachment[];
  onOpenFile?: OpenMessageFile;
  /** Preserve the original message attachment index across ordered runs. */
  indexOffset?: number;
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
            <div
              key={index}
              data-loaded-attachment={indexOffset + index}
              hidden={index >= 3 && !expansion.open}
            >
              <MessageAttachment
                attachment={attachment}
                mediaVisible={index < 3 || expansion.open}
              />
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

function MessageAttachment({
  attachment,
  mediaVisible,
}: {
  attachment: Attachment;
  mediaVisible: boolean;
}) {
  const expansion = useSearchExpansion();
  useLayoutEffect(() => {
    // The materialized list keeps hidden children mounted. Retire a hidden
    // child's old media intent so a later search-only reveal cannot reload it.
    if (!mediaVisible && expansion.userOpen) expansion.choose(false);
  }, [mediaVisible, expansion.userOpen, expansion.choose]);
  // Search may reveal loaded text, but only the user's own expansion admits media.
  const { admission, media, budgetRejected, pending, retry } =
    useMessageMediaPreview(attachment, expansion.userOpen && mediaVisible);
  const mediaRejected = admission?.status === "rejected";
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
        {media && (
          <MessageAttachmentMedia
            key={media.src}
            media={media}
            name={attachment.name}
          />
        )}
        {attachment.uri && (
          <div className="message-file-link" data-find-block>
            {attachment.uri}
          </div>
        )}
        {attachment.text !== undefined && (
          <pre data-find-block data-loaded-attachment-text>
            {attachment.text}
          </pre>
        )}
        {mediaWaiting && (
          <button type="button" onClick={() => expansion.choose(true)}>
            {R.findShowMedia}
          </button>
        )}
        {admission?.status === "rejected" && (
          <p role="status">
            {admission.reason === "tooLarge"
              ? A.mediaTooLarge
              : admission.reason === "tooManyPixels"
                ? A.mediaTooManyPixels
                : admission.reason === "tooComplex"
                  ? A.mediaTooComplex
                  : admission.reason === "audioTooLong"
                    ? A.audioTooLong
                    : admission.reason === "audioTooComplex"
                      ? A.audioTooComplex
                      : A.mediaInvalid}
          </p>
        )}
        {pending && <p role="status">{A.mediaPreparing}</p>}
        {budgetRejected && (
          <div className="message-attachment-media-failure">
            <p role="status">{A.mediaBudgetReached}</p>
            <button
              type="button"
              onClick={(event) => {
                if (!event.currentTarget.isConnected) return;
                // A successful reservation removes this button. Keep keyboard
                // focus on the stable attachment summary, without stealing
                // focus if the user has already moved elsewhere.
                if (document.activeElement === event.currentTarget)
                  event.currentTarget
                    .closest("details")
                    ?.querySelector("summary")
                    ?.focus();
                retry();
              }}
            >
              {A.retryMedia}
            </button>
          </div>
        )}
        {!mediaWaiting &&
          admission?.status !== "available" &&
          !mediaRejected &&
          attachment.data && <p>{A.previewUnavailable}</p>}
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
  contentOrder,
  onOpenFile,
}: {
  source: object;
  text: string;
  attachments?: readonly Attachment[];
  contentOrder?: readonly MessageContentOrderPart[];
  onOpenFile?: OpenMessageFile;
}) {
  const order = checkedMessageContentOrder(
    text.length,
    attachments.length,
    contentOrder,
  );
  return (
    <FileOpenContext.Provider value={onOpenFile ?? null}>
      <div
        className="message-text markdown-body"
        data-find-block
        data-loaded-body
      >
        {order ? (
          order.map((part) =>
            part.kind === "text" ? (
              <div key={`text:${part.start}`} data-find-block>
                {messageTree(part, text.slice(part.start, part.end))}
              </div>
            ) : (
              <MessageAttachments
                key={`attachments:${part.start}`}
                attachments={attachments.slice(part.start, part.end)}
                indexOffset={part.start}
              />
            ),
          )
        ) : (
          <>
            {messageTree(source, text)}
            <MessageAttachments attachments={attachments} />
          </>
        )}
      </div>
    </FileOpenContext.Provider>
  );
});
