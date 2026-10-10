import { beforeEach, expect, it, vi } from "vitest";
import fixture from "./fixtures/storage-restore-v1.json";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});
const preview = (value: unknown) => ({
  id: "a".repeat(48),
  sourcePath: "/fixture/copy.sqlite3",
  values: { "unsentWork.v1": JSON.stringify(value), "agentSetup.v1": null },
});

it.each(Object.values(fixture["unsentWork.v1"].feedback["fixture-thread"]))(
  "recovery accepts the supported historical $anchor.kind and never hydrates or writes",
  async (entry) => {
    const { previewEntries } = await import("./storage_restore");
    const d = await import("./drafts");
    const value = {
      ...fixture["unsentWork.v1"],
      feedback: { "fixture-thread": { one: entry } },
    };
    const before = d.composerDrafts.read("new");
    expect(previewEntries(preview(value), ["unsentWork.v1"])[0].valid).toBe(
      true,
    );
    const parsed = d.parseDraftSnapshot(value)!;
    expect(Object.values(parsed.feedback[0][1])).toEqual([entry]);
    expect(d.composerDrafts.read("new")).toBe(before);
    expect(d.fileFeedbackDrafts.entries("fixture-thread")).toEqual({});
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
it.each([
  {
    anchor: {
      ...fixture["unsentWork.v1"].feedback["fixture-thread"]["area.pdf"].anchor,
      verified: true,
    },
  },
  {
    anchor: {
      ...fixture["unsentWork.v1"].feedback["fixture-thread"]["area.pdf"].anchor,
      space: "pdf-internal",
    },
  },
  {
    anchor: {
      ...fixture["unsentWork.v1"].feedback["fixture-thread"]["area.pdf"].anchor,
      left: 700000,
    },
  },
  {
    anchor: {
      ...fixture["unsentWork.v1"].feedback["fixture-thread"]["area.pdf"].anchor,
      page: 4,
    },
  },
  { scope: "fragment" },
  { contentId: "unknown" },
  { futureSend: true },
])(
  "recovery still rejects whole snapshots with malformed anchor/context or unknown fields",
  async (patch) => {
    const { previewEntries } = await import("./storage_restore");
    const entry =
      fixture["unsentWork.v1"].feedback["fixture-thread"]["area.pdf"];
    const value = {
      ...fixture["unsentWork.v1"],
      feedback: { "fixture-thread": { one: { ...entry, ...patch } } },
    };
    expect(previewEntries(preview(value), ["unsentWork.v1"])[0].valid).toBe(
      false,
    );
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
it("cold loads the exact shared Rust fixture including all six anchor kinds without dispatch", async () => {
  const { previewEntries } = await import("./storage_restore");
  expect(
    previewEntries(preview(fixture["unsentWork.v1"]), ["unsentWork.v1"])[0]
      .valid,
  ).toBe(true);
  h.invoke.mockImplementation(async (name, { key }) => {
    if (name !== "settings_get") throw new Error("unexpected write or send");
    return structuredClone(fixture[key as keyof typeof fixture]);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  const entries = Object.values(d.fileFeedbackDrafts.entries("fixture-thread"));
  expect(entries).toEqual(
    Object.values(fixture["unsentWork.v1"].feedback["fixture-thread"]),
  );
  expect(d.composerDrafts.read("new").sendPending).toBe(true);
  expect(d.composerDrafts.read("new").attachments[0].recovered).toBe(true);
  expect(d.draftQueues.read("fixture-thread")?.uncertainIndex).toBe(0);
  expect(h.invoke.mock.calls.map((c) => c[0])).toEqual(["settings_get"]);
});
