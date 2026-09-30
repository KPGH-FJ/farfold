import { expect, it } from "vitest";
import { readableTranscript } from "./readable_transcript";

// Bounded DOM stand-ins exercise traversal and computed visibility without
// adding a browser runtime or reading a persisted conversation.
interface FixtureNode {
  nodeType: number;
  tagName: string;
  childNodes: (FixtureNode | { nodeType: number; textContent: string })[];
  children: FixtureNode[];
  hidden: boolean;
  getAttribute: (key: string) => string | null;
  hasAttribute: (key: string) => boolean;
  ownerDocument: {
    defaultView: {
      getComputedStyle: () => { display: string; visibility: string };
    };
  };
}
type Child = string | FixtureNode;
function element(
  tagName: string,
  children: Child[] = [],
  attrs: Record<string, string> = {},
  style = { display: "block", visibility: "visible" },
): FixtureNode {
  const childNodes = children.map((child) =>
    typeof child === "string" ? { nodeType: 3, textContent: child } : child,
  );
  return {
    nodeType: 1,
    tagName,
    childNodes,
    children: childNodes.filter(
      (node): node is FixtureNode => "tagName" in node,
    ),
    hidden: "hidden" in attrs,
    getAttribute: (key: string) => attrs[key] ?? null,
    hasAttribute: (key: string) => key in attrs,
    ownerDocument: { defaultView: { getComputedStyle: () => style } },
  };
}
const copy = (root: ReturnType<typeof element>) =>
  readableTranscript(root as unknown as Element, "Conversation title");

it("includes displayed text, attachment descriptions, and expanded steps but no controls or collapsed bodies", () => {
  const root = element("DIV", [
    element("P", ["Hello", element("BR"), "Second line"]),
    element("FIGURE", [
      element("FIGCAPTION", ["notes.txt", element("SMALL", ["text/plain"])]),
      element("PRE", ["Attached excerpt"]),
    ]),
    element("DETAILS", [
      element("SUMMARY", ["2 steps"]),
      element("P", ["Hidden step output"]),
    ]),
    element(
      "DETAILS",
      [
        element("SUMMARY", ["Expanded step"]),
        element("PRE", ["Actual output"]),
        element("BUTTON", ["Open artifact"]),
      ],
      { open: "" },
    ),
    element("BUTTON", ["Approve"]),
    element("TEXTAREA", ["Unsent draft"]),
    element("SPAN", ["Copied"], { "data-copy-exclude": "" }),
  ]);
  const result = copy(root);
  for (const value of [
    "Conversation title",
    "Hello\nSecond line",
    "notes.txt",
    "text/plain",
    "Attached excerpt",
    "2 steps",
    "Expanded step",
    "Actual output",
  ])
    expect(result).toContain(value);
  for (const value of [
    "Hidden step output",
    "Open artifact",
    "Approve",
    "Unsent draft",
    "Copied",
  ])
    expect(result).not.toContain(value);
});

it("excludes hidden content and preserves code whitespace and visible table columns", () => {
  const root = element("DIV", [
    element("P", ["hidden attribute"], { hidden: "" }),
    element("P", ["aria hidden"], { "aria-hidden": "true" }),
    element(
      "P",
      ["display none"],
      {},
      { display: "none", visibility: "visible" },
    ),
    element(
      "P",
      ["visibility hidden"],
      {},
      { display: "block", visibility: "hidden" },
    ),
    element("PRE", ["  first\n    second"]),
    element("TR", [element("TD", ["Name"]), element("TD", ["Value"])]),
  ]);
  const result = copy(root);
  expect(result).toContain("  first\n    second");
  expect(result).toContain("Name\tValue");
  expect(result).not.toMatch(/hidden|display none/);
  expect(readableTranscript(null, "Only title")).toBe("Only title");
});
