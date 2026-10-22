import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MESSAGE_ATTACHMENTS as A } from "./message_attachment_strings";

const boundaries = new Set([
  "p",
  "div",
  "pre",
  "li",
  "td",
  "th",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "blockquote",
  "tr",
  "br",
]);

/** Same synchronous Markdown/GFM pipeline as MessageContent, without mounting
 * components, HTML, media, links or file actions. Inline text joins; blocks don't. */
export function loadedMarkdownFields(text: string): string[] {
  const fields: string[] = [];
  let pieces: string[] = [];
  const flush = () => {
    if (pieces.length) fields.push(pieces.join(""));
    pieces = [];
  };
  const visit = (node: ReactNode) => {
    if (typeof node === "string" || typeof node === "number") {
      pieces.push(String(node));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (
      !isValidElement<{
        children?: ReactNode;
        alt?: string;
        "aria-hidden"?: boolean | string;
      }>(node)
    )
      return;
    if (
      node.props["aria-hidden"] === true ||
      node.props["aria-hidden"] === "true"
    ) {
      flush();
      return;
    }
    // MessageContent renders images as explicit links with this visible label.
    // Match that text without including or opening the image destination.
    if (node.type === "img") {
      pieces.push(node.props.alt || A.kindNames.image);
      return;
    }
    const block = typeof node.type === "string" && boundaries.has(node.type);
    if (block) flush();
    visit(node.props.children);
    if (block) flush();
  };
  visit(ReactMarkdown({ children: text, remarkPlugins: [remarkGfm] }));
  flush();
  return fields;
}
