import { isValidElement, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

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
    const block = typeof node.type === "string" && boundaries.has(node.type);
    if (block) flush();
    visit(node.props.children);
    if (block) flush();
  };
  visit(ReactMarkdown({ children: text, remarkPlugins: [remarkGfm] }));
  flush();
  return fields;
}
