import { expect, it } from "vitest";
import { freshThreadState } from "./session_projection";
import {
  loadedSearchHitField,
  loadedSearchHitIsCurrent,
  searchLoadedConversations,
} from "./loaded_search";

async function search(text: string, source: "user" | "agent" | "attachment") {
  const state = freshThreadState("thread", "controlled", "/work", "native");
  state.items.push({
    kind: source === "agent" ? "agent" : "user",
    id: "message",
    text: source === "attachment" ? "body without the query" : text,
    streaming: false,
    time: 1,
    attachments:
      source === "attachment" ? [{ name: "received text", text }] : [],
  });
  const states = new Map([[state.key, state]]);
  const result = await searchLoadedConversations(
    [state.key],
    states,
    "needle",
    {
      yieldControl: async () => {},
      parseMarkdown: async (value) => [value],
    },
  );
  expect(result.matches).toBe(1);
  expect(result.hits).toHaveLength(1);
  const hit = result.hits[0];
  expect(hit.match).toBe("needle");
  expect(loadedSearchHitIsCurrent(hit, states)).toBe(true);
  expect(loadedSearchHitField(hit)).toMatchObject({
    text,
    start: text.indexOf("needle"),
    end: text.indexOf("needle") + 6,
  });
  return hit;
}

it.each(["user", "agent", "attachment"] as const)(
  "does not invent a lone low surrogate at the %s context start",
  async (source) => {
    const hit = await search("🙂" + "a".repeat(55) + "needle", source);
    expect(hit.before).toBe("a".repeat(55));
    expect(new TextDecoder().decode(new TextEncoder().encode(hit.before))).toBe(
      hit.before,
    );
  },
);

it.each(["user", "agent", "attachment"] as const)(
  "does not invent a lone high surrogate at the %s context end",
  async (source) => {
    const hit = await search("needle" + "b".repeat(87) + "🙂", source);
    expect(hit.after).toBe("b".repeat(87));
    expect(new TextDecoder().decode(new TextEncoder().encode(hit.after))).toBe(
      hit.after,
    );
  },
);

it("keeps complete supplementary characters and the existing ASCII window sizes", async () => {
  const hit = await search(
    "🙂" + "a".repeat(54) + "needle" + "b".repeat(86) + "🙂",
    "user",
  );
  expect(hit.before).toBe("🙂" + "a".repeat(54));
  expect(hit.after).toBe("b".repeat(86) + "🙂");
  const ascii = await search(
    "a".repeat(80) + "needle" + "b".repeat(100),
    "user",
  );
  expect(ascii.before).toBe("a".repeat(56));
  expect(ascii.after).toBe("b".repeat(88));
});
