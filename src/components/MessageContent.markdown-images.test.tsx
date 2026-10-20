import { afterEach, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MessageContent } from "./MessageContent";
import { MessageMediaVisibility } from "./message-media-visibility";
import { SearchDisclosure } from "./transcript-search";
import {
  messageMediaBudget,
  MAX_ACTIVE_MESSAGE_MEDIA,
  type MessageMediaLease,
} from "../runtime/message_media_budget";
import { PNG_IMAGE_TEST_DATA } from "../runtime/image_fixtures.test-support";

// Unmocked production React/Markdown/MessageContent and shared pool. SSR does
// not commit effects, fetch a network source, decode pixels or measure RSS.
// The semantic boundary is absence of a loading-capable img/preload source
// when no user opening/visible media owner or free lease is available.
const leases: MessageMediaLease[] = [];
const url = (index: number) =>
  `https://example.invalid/owned-picture-${index}.png`;
function observe(name: string, html: string) {
  const row = {
    name,
    images: (html.match(/<img\b/g) ?? []).length,
    preloads: (html.match(/<link\b[^>]*rel="preload"/g) ?? []).length,
    loadingSources: [
      ...html.matchAll(/<(?:img|link)\b[^>]*(?:src|href)="([^"]+)"/g),
    ].map((m) => m[1]),
    actions: [...html.matchAll(/<(a|button)\b[^>]*>/g)].map((m) => m[0]),
  };
  return row;
}
function fill() {
  for (let i = 0; i < MAX_ACTIVE_MESSAGE_MEDIA; i++) {
    const lease = messageMediaBudget.acquire(1);
    expect(lease).not.toBeNull();
    leases.push(lease!);
  }
  expect(messageMediaBudget.acquire(1)).toBeNull();
}
afterEach(() => {
  for (const lease of leases.splice(0)) lease.release();
});

it("keeps a normal Markdown link readable without turning it into a media request", () => {
  fill();
  const html = renderToStaticMarkup(
    <MessageContent source={{}} text={`[Original picture](${url(0)})`} />,
  );
  const row = observe("ordinary-link-control", html);
  expect(html).toContain(`href="${url(0)}"`);
  expect(html).toContain("Original picture");
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
});

it("keeps the unopened structured image free of a loading source under the real quota", () => {
  fill();
  const html = renderToStaticMarkup(
    <MessageContent
      source={{}}
      text="Following original text"
      attachments={[
        {
          name: "Original image",
          kind: "image",
          mimeType: "image/png",
          data: PNG_IMAGE_TEST_DATA,
        },
      ]}
    />,
  );
  const row = observe("structured-unopened-control", html);
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
  expect(html).toContain("Original image");
  expect(html).toContain("Following original text");
});

it("does not give five Markdown images loading sources beyond four existing real leases", () => {
  fill();
  const text = Array.from(
    { length: 5 },
    (_, i) => `![Original ${i}](${url(i)})`,
  ).join("\n\n");
  const row = observe(
    "quota-full-markdown",
    renderToStaticMarkup(<MessageContent source={{}} text={text} />),
  );
  expect(messageMediaBudget.acquire(1)).toBeNull();
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
});

it("withdraws Markdown image sources behind the same hidden transcript boundary", () => {
  const row = observe(
    "hidden-markdown",
    renderToStaticMarkup(
      <MessageMediaVisibility visible={false}>
        <MessageContent source={{}} text={`![Original hidden](${url(10)})`} />
      </MessageMediaVisibility>,
    ),
  );
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
});

it("keeps a closed production disclosure from assigning its Markdown child image a source", () => {
  const row = observe(
    "closed-disclosure-markdown",
    renderToStaticMarkup(
      <SearchDisclosure>
        <summary>Closed original tool output</summary>
        <MessageContent source={{}} text={`![Original folded](${url(11)})`} />
      </SearchDisclosure>,
    ),
  );
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
});

it("preserves inline, reference and empty-label image sources as explicit links without mutating original text", () => {
  const cases = [
    {
      name: "inline-markdown",
      text: `![Inline original](${url(20)})`,
      label: "Inline original",
      target: url(20),
    },
    {
      name: "reference-markdown",
      text: `![Reference original][picture]\n\n[picture]: ${url(21)}`,
      label: "Reference original",
      target: url(21),
    },
    {
      name: "empty-alt-markdown",
      text: `![](${url(22)})`,
      label: "图片",
      target: url(22),
    },
    {
      name: "local-markdown",
      text: "![Local original](file:///tmp/farfold-owned-image.png)",
      label: "Local original",
      target: "/tmp/farfold-owned-image.png",
    },
  ];
  const results = cases.map(({ name, text, label, target }) => {
    const source = Object.freeze({ original: text });
    const html = renderToStaticMarkup(
      <MessageContent source={source} text={text} onOpenFile={() => {}} />,
    );
    const repeated = renderToStaticMarkup(
      <MessageContent source={source} text={text} onOpenFile={() => {}} />,
    );
    const row = observe(name, html);
    return {
      ...row,
      labelRetained: html.includes(label),
      targetRetained: html.includes(target),
      originalExact: source.original === text,
      repeatedExact: html === repeated,
    };
  });
  expect(results).toEqual(
    cases.map(() =>
      expect.objectContaining({
        images: 0,
        preloads: 0,
        labelRetained: true,
        targetRetained: true,
        originalExact: true,
        repeatedExact: true,
      }),
    ),
  );
});

it("retains the unique outer action of a linked image without nesting another action", () => {
  const outer = "https://example.invalid/original-outer";
  const html = renderToStaticMarkup(
    <MessageContent
      source={{}}
      text={`[![Linked original](${url(30)})](${outer})`}
    />,
  );
  const row = observe("linked-image-markdown", html);
  expect(row.actions).toHaveLength(1);
  expect(html).toContain(`href="${outer}"`);
  expect(html).toContain("Linked original");
  expect(row.images).toBe(0);
  expect(row.preloads).toBe(0);
});

it("does not activate unsafe image destinations and preserves their labels", () => {
  const cases = [
    ["data-markdown", "data:image/png;base64,AAAA"],
    ["blob-markdown", "blob:https://example.invalid/owned"],
    ["javascript-markdown", "javascript:alert%281%29"],
  ];
  const rows = cases.map(([name, src]) => {
    const html = renderToStaticMarkup(
      <MessageContent source={{}} text={`![Unsafe original](${src})`} />,
    );
    return {
      ...observe(name, html),
      labelRetained: html.includes("Unsafe original"),
      noDangerousHref: !/href="(?:data|blob|javascript):/i.test(html),
    };
  });
  expect(rows).toEqual(
    cases.map(() =>
      expect.objectContaining({
        images: 0,
        preloads: 0,
        actions: [],
        labelRetained: true,
        noDangerousHref: true,
      }),
    ),
  );
});
