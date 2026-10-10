import { afterEach, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SaxesParser } from "saxes";
import {
  MessageContent,
  MessageAttachments,
} from "../components/MessageContent";
import { UserMessageContent } from "../components/UserMessageContent";
import { TranscriptSearchContext } from "../components/transcript-search";
import { applyUpdate, freshThreadState } from "./session_projection";
import { finishHistoryPrefix } from "./history_replay";
import {
  searchLoadedConversations,
  loadedMarkdownFields,
} from "./loaded_search";
import { loadedSearchDOMRange } from "./loaded_search_dom";

type TextNode = {
  nodeType: 3;
  data: string;
  textContent: string;
  length: number;
};
class ElementNode {
  nodeType = 1;
  childNodes: (ElementNode | TextNode)[] = [];
  dataset: Record<string, string>;
  constructor(
    readonly tagName: string,
    readonly attrs: Record<string, string>,
  ) {
    this.dataset = Object.fromEntries(
      Object.entries(attrs)
        .filter(([name]) => name.startsWith("data-"))
        .map(([name, value]) => [
          name.slice(5).replace(/-([a-z])/g, (_, c: string) => c.toUpperCase()),
          value,
        ]),
    );
  }
  classList = {
    contains: (name: string) =>
      (this.attrs.class ?? "").split(" ").includes(name),
  };
  hasAttribute = (name: string) => name in this.attrs;
  matches = (selector: string): boolean =>
    selector.split(/,\s*/).some((part) => {
      if (part.startsWith(".")) return this.classList.contains(part.slice(1));
      const attribute = /^\[([^=\]]+)(?:=['"]([^'"]*)['"])?\]$/.exec(part);
      return attribute
        ? this.hasAttribute(attribute[1]) &&
            (attribute[2] === undefined ||
              this.attrs[attribute[1]] === attribute[2])
        : part.toUpperCase() === this.tagName;
    });
  querySelectorAll = (selector: string): ElementNode[] =>
    this.childNodes.flatMap((node) =>
      node instanceof ElementNode
        ? [
            ...(node.matches(selector) ? [node] : []),
            ...node.querySelectorAll(selector),
          ]
        : [],
    );
  querySelector = (selector: string) =>
    this.querySelectorAll(selector)[0] ?? null;
}
// Parse production React SSR, not a hand-built copy of the message structure.
// This seam verifies field/range correspondence; native layout is tested separately.
function dom(html: string) {
  const root = new ElementNode("DIV", {}),
    stack = [root];
  const parser = new SaxesParser();
  parser.on("opentag", (tag) => {
    const node = new ElementNode(
      tag.name.toUpperCase(),
      tag.attributes as Record<string, string>,
    );
    stack.at(-1)!.childNodes.push(node);
    stack.push(node);
  });
  parser.on("closetag", () => {
    stack.pop();
  });
  parser.on("text", (data) => {
    stack.at(-1)!.childNodes.push({
      nodeType: 3,
      data,
      textContent: data,
      length: data.length,
    });
  });
  parser.write(`<root>${html}</root>`).close();
  const texts = (node: ElementNode): TextNode[] =>
    node.childNodes.flatMap((child) =>
      child instanceof ElementNode ? texts(child) : [child],
    );
  const all = texts(root);
  vi.stubGlobal("document", {
    createRange: () => ({
      start: undefined as TextNode | undefined,
      end: undefined as TextNode | undefined,
      from: 0,
      to: 0,
      setStart(node: TextNode, offset: number) {
        this.start = node;
        this.from = offset;
      },
      setEnd(node: TextNode, offset: number) {
        this.end = node;
        this.to = offset;
      },
      toString() {
        const first = all.indexOf(this.start!),
          last = all.indexOf(this.end!);
        return all
          .slice(first, last + 1)
          .map((node, index) =>
            node.data.slice(
              index === 0 ? this.from : 0,
              first + index === last ? this.to : undefined,
            ),
          )
          .join("");
      },
    }),
  });
  return root as unknown as HTMLElement;
}
afterEach(() => vi.unstubAllGlobals());
async function fixture(
  text: string,
  query: string,
  user = false,
  attachments = false,
) {
  const state = freshThreadState("thread", "agent", "/controlled", "native");
  applyUpdate(state, {
    sessionUpdate: `${user ? "user" : "agent"}_message_chunk`,
    messageId: "m",
    content: { type: "text", text },
  });
  if (attachments)
    for (let i = 0; i < 4; i++)
      applyUpdate(state, {
        sessionUpdate: `${user ? "user" : "agent"}_message_chunk`,
        messageId: "m",
        content: {
          type: "resource",
          resource: {
            uri: `file:///never-read/${i}.txt`,
            text: i === 3 ? "fourth needle attachment" : "other",
          },
        },
      });
  if (user) finishHistoryPrefix(state);
  const item = state.items.find(
    (item) => item.kind === (user ? "user" : "agent"),
  )!;
  if (item.kind !== "agent" && item.kind !== "user")
    throw new Error("Missing message");
  const hits = (
    await searchLoadedConversations(
      [state.key],
      new Map([[state.key, state]]),
      query,
      {
        yieldControl: async () => {},
        parseMarkdown: async (text: string) => loadedMarkdownFields(text),
      },
    )
  ).hits;
  const html = renderToStaticMarkup(
    <TranscriptSearchContext.Provider value={true}>
      <div data-loaded-message={item.id}>
        {user ? (
          <>
            <UserMessageContent text={item.text} historical />
            <MessageAttachments attachments={item.attachments ?? []} />
          </>
        ) : (
          <MessageContent
            source={item}
            text={item.text}
            attachments={item.attachments}
            onOpenFile={() => {
              throw new Error("No file action");
            }}
          />
        )}
      </div>
    </TranscriptSearchContext.Provider>,
  );
  return { html, hits };
}
it.each([
  ["# heading\n\nfirst **needle** and `inline`\n\nsecond needle", "needle"],
  ["- first needle\n- second needle\n\n> quoted needle", "needle"],
  ["| first | second |\n|---|---|\n|needle|needle|", "needle"],
  [
    "before\n\n```js\nneedle\n```\n\n`report.md` [needle](file:///report.md)",
    "needle",
  ],
  [
    "a **bold** &amp; `code` [label](https://invalid.example)",
    "a bold & code label",
  ],
])(
  "finds actual rendered Markdown fields without borrowing duplicate text: %s",
  async (text, query) => {
    const { html, hits } = await fixture(text, query);
    expect(hits.length).toBeGreaterThan(0);
    const root = dom(html);
    for (const hit of hits)
      expect(loadedSearchDOMRange(root, hit)?.range.toString()).toBe(hit.match);
  },
);
it("finds the fourth folded received text without reading its file or matching generated labels", async () => {
  const { html, hits } = await fixture(
    "same needle body",
    "needle",
    true,
    true,
  );
  expect(hits).toHaveLength(2);
  expect(hits[1].attachmentIndex).toBe(3);
  const root = dom(html);
  expect(loadedSearchDOMRange(root, hits[1])?.range.toString()).toBe("needle");
  expect(html).not.toContain("<img");
});
it("keeps historical inline image gaps separate from adjacent text", async () => {
  const { html, hits } = await fixture(
    "before needle [@image](data:image/png;base64,YWJjZA==) after needle",
    "needle",
    true,
  );
  expect(hits).toHaveLength(2);
  const root = dom(html);
  hits.forEach((hit) =>
    expect(loadedSearchDOMRange(root, hit)?.range.toString()).toBe("needle"),
  );
  expect(html).not.toContain("<img");
});
it("rejects duplicate message IDs and changed DOM fields instead of falling back to another matching word", async () => {
  const { html, hits } = await fixture("needle repeated needle", "needle");
  expect(loadedSearchDOMRange(dom(html + html), hits[0])).toBeNull();
  expect(
    loadedSearchDOMRange(
      dom(html.replace("needle repeated needle", "changed needle")),
      hits[0],
    ),
  ).toBeNull();
});
