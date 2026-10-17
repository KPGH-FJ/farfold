import { expect, it } from "vitest";
import { freshThreadState } from "./session_projection";
import type { MessageContentOrderPart } from "./message_content_order";
import {
  loadedMarkdownFields,
  loadedSearchHitField,
  loadedSearchHitIsCurrent,
  LOADED_SEARCH_LIMITS,
  searchLoadedConversations,
} from "./loaded_search";

const immediate = {
  yieldControl: async () => {},
  parseMarkdown: async (text: string) => loadedMarkdownFields(text),
};
function fixture(
  text = "leftright",
  order: readonly MessageContentOrderPart[] | undefined = [
    { kind: "text", start: 0, end: 4 },
    { kind: "attachments", start: 0, end: 1 },
    { kind: "text", start: 4, end: 9 },
  ],
) {
  const state = freshThreadState("thread", "controlled", "/work", "native");
  const item = {
    kind: "agent" as const,
    id: "message",
    text,
    contentOrder: order as readonly MessageContentOrderPart[] | undefined,
    attachments: [
      {
        kind: "resource" as const,
        name: "received note",
        uri: "file:///never-read/note.txt",
        text: "received attachment needle",
      },
    ],
    streaming: false,
    time: 1,
  };
  state.items.push(item);
  const states = new Map([[state.key, state]]);
  const search = (query: string) =>
    searchLoadedConversations([state.key], states, query, immediate);
  return { state, states, item, search };
}

it("does not invent a match across an observed attachment boundary", async () => {
  const { search } = fixture();
  expect((await search("leftright")).matches).toBe(0);
});

it("parses each complete text run and keeps its flattened DOM field index", async () => {
  const { search } = fixture("**left**right", [
    { kind: "text", start: 0, end: 8 },
    { kind: "attachments", start: 0, end: 1 },
    { kind: "text", start: 8, end: 13 },
  ]);
  const result = await search("right");
  expect(result.fields).toBe(3); // Two body fields and one received-text field.
  expect(result.hits).toHaveLength(1);
  expect(loadedSearchHitField(result.hits[0])).toEqual({
    index: 1,
    text: "right",
    start: 0,
    end: 5,
  });
});

it.each(["**left", "right**"])(
  "does not join Markdown syntax over media: %s",
  async (query) => {
    const { search } = fixture("**leftright**", [
      { kind: "text", start: 0, end: 6 },
      { kind: "attachments", start: 0, end: 1 },
      { kind: "text", start: 6, end: 13 },
    ]);
    expect((await search(query)).matches).toBe(1);
  },
);

it("invalidates a body hit if only the observed order changes", async () => {
  const { item, states, search } = fixture();
  const hit = (await search("right")).hits[0];
  expect(loadedSearchHitIsCurrent(hit, states)).toBe(true);
  item.contentOrder = [
    { kind: "attachments", start: 0, end: 1 },
    { kind: "text", start: 0, end: 9 },
  ];
  expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
});

it("compares range values rather than trusting an unchanged array identity", async () => {
  const order = [
    { kind: "text" as const, start: 0, end: 4 },
    { kind: "attachments" as const, start: 0, end: 1 },
    { kind: "text" as const, start: 4, end: 9 },
  ];
  const { search, states } = fixture("leftright", order);
  const hit = (await search("right")).hits[0];
  order[0].end = 5;
  order[2].start = 5;
  expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
});

it("retains a hit for an equivalent order array and its exact attachment owner", async () => {
  const { item, states, search } = fixture();
  const bodyHit = (await search("right")).hits[0];
  const attachmentHit = (await search("needle")).hits[0];
  item.contentOrder = item.contentOrder!.map((part) => ({ ...part }));
  expect(loadedSearchHitIsCurrent(bodyHit, states)).toBe(true);
  expect(loadedSearchHitIsCurrent(attachmentHit, states)).toBe(true);
  expect(attachmentHit.attachmentIndex).toBe(0);
});

it("retains full legacy search for absent or invalid ordering metadata", async () => {
  for (const order of [
    undefined,
    [{ kind: "text" as const, start: 0, end: 4 }],
  ]) {
    const { item, search } = fixture();
    item.contentOrder = order;
    expect((await search("leftright")).matches).toBe(1);
  }
});

it("does not let text-run splitting bypass the existing whole-body budget", async () => {
  const text = "x".repeat(LOADED_SEARCH_LIMITS.fieldCharacters + 1);
  const { search } = fixture(text, [
    { kind: "text", start: 0, end: 1 },
    { kind: "attachments", start: 0, end: 1 },
    { kind: "text", start: 1, end: text.length },
  ]);
  expect(await search("x")).toMatchObject({
    matches: 0,
    skippedFields: 1,
    limited: true,
  });
});

it("rejects an order changed while Markdown parsing was pending", async () => {
  const { item, state, states } = fixture();
  let first = true;
  const result = await searchLoadedConversations([state.key], states, "right", {
    ...immediate,
    parseMarkdown: async (text) => {
      if (first) {
        first = false;
        item.contentOrder = [
          { kind: "text", start: 0, end: 9 },
          { kind: "attachments", start: 0, end: 1 },
        ];
      }
      return loadedMarkdownFields(text);
    },
  });
  expect(result.hits).toHaveLength(1);
  expect(loadedSearchHitIsCurrent(result.hits[0], states)).toBe(false);
});

it("keeps cancellation active between ordered Markdown parses", async () => {
  const { state, states } = fixture();
  const controller = new AbortController();
  await expect(
    searchLoadedConversations([state.key], states, "right", {
      ...immediate,
      signal: controller.signal,
      parseMarkdown: async (text) => {
        controller.abort();
        return loadedMarkdownFields(text);
      },
    }),
  ).rejects.toMatchObject({ name: "AbortError" });
});
