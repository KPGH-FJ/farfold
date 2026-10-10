import { describe, expect, it } from "vitest";
import { applyUpdate, freshThreadState } from "./session_projection";
import { finishHistoryPrefix } from "./history_replay";
import {
  loadedMarkdownFields,
  loadedSearchHitField,
  loadedSearchHitIsCurrent,
  LOADED_SEARCH_LIMITS,
  searchLoadedConversations,
} from "./loaded_search";
import type { ThreadState } from "./session_types";

function state(id: string) {
  return freshThreadState(id, "controlled", "/test", id);
}
function message(
  s: ThreadState,
  id: string,
  text: string,
  role: "user" | "agent" = "agent",
) {
  applyUpdate(s, {
    sessionUpdate: `${role}_message_chunk`,
    messageId: id,
    content: { type: "text", text },
  });
}
const immediate = {
  yieldControl: async () => {},
  parseMarkdown: async (text: string) => loadedMarkdownFields(text),
};
describe("loaded message search from actual projected protocol events", () => {
  it("separates cold metadata and unconfirmed history from actually searched body", async () => {
    const a = state("a"),
      b = state("b"),
      broken = state("broken");
    message(a, "first", "unique body");
    message(b, "second", "different body");
    message(broken, "partial", "unique partial");
    broken.historyUnavailable = { reason: "incomplete", sourceKnown: true };
    const states = new Map([
      ["a", a],
      ["b", b],
      ["broken", broken],
    ]);
    const result = await searchLoadedConversations(
      ["a", "b", "cold", "broken", "a"],
      states,
      "unique",
      immediate,
    );
    expect(result).toMatchObject({
      conversations: 4,
      loaded: 2,
      unloaded: 1,
      unavailable: 1,
      matches: 1,
    });
    expect(result.hits[0].threadKey).toBe("a");
    expect(loadedSearchHitIsCurrent(result.hits[0], states)).toBe(true);
    expect(loadedSearchHitIsCurrent(result.hits[0], states, ["b"])).toBe(false);
  });
  it("matches Markdown visible inline text but never joins paragraphs, cells or messages", async () => {
    const a = state("a");
    message(
      a,
      "first",
      "alpha **beta** `code`\n\none\n\ntwo\n\n|left|right|\n|-|-|\n|cellA|cellB|",
    );
    const states = new Map([["a", a]]);
    expect(
      (
        await searchLoadedConversations(
          ["a"],
          states,
          "alpha beta code",
          immediate,
        )
      ).matches,
    ).toBe(1);
    for (const query of ["one\n\ntwo", "cellAcellB", "left right"])
      expect(
        (await searchLoadedConversations(["a"], states, query, immediate))
          .matches,
      ).toBe(0);
    message(a, "second", "never cross");
    message(a, "third", "message boundary");
    expect(
      (
        await searchLoadedConversations(
          ["a"],
          states,
          "crossmessage",
          immediate,
        )
      ).matches,
    ).toBe(0);
  });
  it("retains exact duplicate item, Unicode offsets and the fourth received attachment", async () => {
    const a = state("a"),
      b = state("b");
    message(a, "one", "İ 😀 repeated repeated", "user");
    message(a, "two", "İ 😀 repeated repeated", "user");
    message(b, "one", "İ 😀 repeated repeated", "user");
    for (let index = 0; index < 4; index++)
      applyUpdate(a, {
        sessionUpdate: "user_message_chunk",
        messageId: "two",
        content: {
          type: "resource",
          resource: {
            uri: `file:///never-read/${index}.txt`,
            text: index === 3 ? "received needle" : "other",
          },
        },
      });
    const states = new Map([
      ["a", a],
      ["b", b],
    ]);
    const result = await searchLoadedConversations(
      ["a", "b"],
      states,
      "repeated",
      immediate,
    );
    expect(result.matches).toBe(6);
    expect(loadedSearchHitField(result.hits[0])?.start).toBe(5);
    expect(result.hits[0].itemId).not.toBe(result.hits[2].itemId);
    expect(result.hits[4].threadKey).toBe("b");
    const attachment = await searchLoadedConversations(
      ["a"],
      states,
      "needle",
      immediate,
    );
    expect(attachment.hits[0]).toMatchObject({
      attachmentIndex: 3,
      role: "user",
    });
    expect(
      (await searchLoadedConversations(["a"], states, "never-read", immediate))
        .matches,
    ).toBe(0);
  });
  it("rejects copied hits, stream changes, replaced attachment/message/thread and changed identity", async () => {
    const a = state("a");
    message(a, "one", "target");
    const states = new Map([["a", a]]);
    const hit = (
      await searchLoadedConversations(["a"], states, "target", immediate)
    ).hits[0];
    expect(loadedSearchHitIsCurrent({ ...hit }, states)).toBe(false);
    const item = a.items[0];
    a.items = [{ ...item }];
    expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
    a.items = [item];
    a.cwd = "/other";
    expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
    a.cwd = "/test";
    message(a, "one", " changed");
    expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
    states.set("a", { ...a });
    expect(loadedSearchHitIsCurrent(hit, states)).toBe(false);
  });
  it("does not search thoughts, tool fields, resource link targets or embedded image payloads", async () => {
    const a = state("a");
    applyUpdate(a, {
      sessionUpdate: "agent_thought_chunk",
      content: { type: "text", text: "secret-needle" },
    });
    applyUpdate(a, {
      sessionUpdate: "tool_call",
      toolCallId: "tool",
      title: "secret-needle",
      content: [
        { type: "content", content: { type: "text", text: "secret-needle" } },
      ],
    });
    message(
      a,
      "history",
      "before [@image](data:image/png;base64,YWJjZA==) after",
      "user",
    );
    finishHistoryPrefix(a);
    applyUpdate(a, {
      sessionUpdate: "agent_message_chunk",
      messageId: "link",
      content: {
        type: "resource_link",
        name: "secret-needle",
        uri: "https://invalid.example/secret-needle",
      },
    });
    for (const query of ["secret-needle", "YWJjZA=="])
      expect(
        (
          await searchLoadedConversations(
            ["a"],
            new Map([["a", a]]),
            query,
            immediate,
          )
        ).matches,
      ).toBe(0);
  });
  it("reports bounded results separately from exact scanned count and oversized omissions", async () => {
    const a = state("a");
    message(a, "dense", "a".repeat(160_000), "user");
    message(
      a,
      "over",
      "a".repeat(LOADED_SEARCH_LIMITS.fieldCharacters + 1),
      "user",
    );
    const result = await searchLoadedConversations(
      ["a"],
      new Map([["a", a]]),
      "a",
      immediate,
    );
    expect(result).toMatchObject({
      matches: 160_000,
      skippedFields: 1,
      limited: true,
    });
    expect(result.hits).toHaveLength(200);
  });
  it("cancels a high-density scan at a scheduled boundary without publishing a partial result", async () => {
    const a = state("a");
    message(a, "dense", "a".repeat(50_000), "user");
    const abort = new AbortController();
    let checkpoints = 0;
    await expect(
      searchLoadedConversations(["a"], new Map([["a", a]]), "a", {
        signal: abort.signal,
        yieldControl: async () => {
          if (++checkpoints === 2) abort.abort();
        },
      }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(checkpoints).toBe(2);
  });
  it("does not reassign an in-progress scan to an identity changed while the worker was parsing", async () => {
    const a = state("a");
    message(a, "identity", "needle");
    const states = new Map([["a", a]]);
    const result = await searchLoadedConversations(["a"], states, "needle", {
      ...immediate,
      parseMarkdown: async (text) => {
        a.cwd = "/different";
        return loadedMarkdownFields(text);
      },
    });
    expect(result.hits).toHaveLength(1);
    expect(loadedSearchHitIsCurrent(result.hits[0], states)).toBe(false);
  });
  it("keeps literal punctuation and Markdown source syntax out of visible word matching", () => {
    expect(
      loadedMarkdownFields(
        "a **bold** &amp; `code` [label](https://invalid.example)",
      ),
    ).toContain("a bold & code label");
  });
});
