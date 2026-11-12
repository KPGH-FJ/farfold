import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset();
});

async function fixture() {
  let disk: unknown = null;
  let fail = false;
  const writes: unknown[] = [];
  h.invoke.mockImplementation(async (command, args) => {
    if (command === "settings_get") return structuredClone(disk);
    expect(command).toBe("settings_set");
    expect(args.key).toBe("unsentWork.v1");
    if (fail) throw new Error("fixture storage failure");
    disk = structuredClone(args.value);
    writes.push(disk);
    return null;
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  d.newConversationChoice.agentId = "owned-agent";
  d.newConversationChoice.cwd = "/owned";
  d.newConversationChoice.config = { model: "chosen", reasoning: "off" };
  d.composerDrafts.update("new", () => ({
    text: "Keep all text",
    attachments: [
      {
        id: "file",
        kind: "file",
        name: "owned.txt",
        uri: "file:///owned/owned.txt",
        deliveryMode: "location",
      },
    ],
  }));
  d.fileFeedbackDrafts.update("owned", "/owned/owned.txt", {
    text: "Unsent opinion",
    contentId: "original-version",
    selection: null,
  });
  await d.draftPersistence.flush();
  return {
    d,
    disk: () => disk,
    writes,
    fail: (value: boolean) => {
      fail = value;
    },
  };
}

it("saves source removal and complete target adoption together, preserving opinions and choices through cold recovery", async () => {
  const f = await fixture(),
    { d } = f;
  const original = d.composerDrafts.read("new");
  const generation = d.composerDrafts.generation("new");
  const firstWrite = f.writes.length;
  const observed: boolean[] = [];
  const stop = d.composerDrafts.subscribe(() =>
    observed.push(
      !d.composerDrafts.hasContent("new") &&
        d.composerDrafts.read("session:owned") === original,
    ),
  );
  expect(d.composerDrafts.movePreparedToSession("owned", original)).toBe(true);
  stop();
  expect(observed).toEqual([true]);
  expect(d.composerDrafts.generation("new")).toBe(generation + 1);
  await d.draftPersistence.flush();
  expect(f.writes.slice(firstWrite)).toHaveLength(1);
  expect(f.disk()).toMatchObject({ composers: { "session:owned": original } });
  expect((f.disk() as { composers: object }).composers).not.toHaveProperty(
    "new",
  );
  vi.resetModules();
  const cold = await import("./drafts");
  await cold.draftPersistence.load();
  expect(cold.composerDrafts.read("session:owned")).toMatchObject(original);
  expect(cold.composerDrafts.hasContent("new")).toBe(false);
  expect(
    cold.fileFeedbackDrafts.read(
      "owned",
      "/owned/owned.txt",
      "original-version",
    ).text,
  ).toBe("Unsent opinion");
  expect(cold.newConversationChoice.config).toEqual({
    model: "chosen",
    reasoning: "off",
  });
});

it("retains the old on-disk input if saving the move fails, and saves the same target on explicit retry", async () => {
  const f = await fixture(),
    { d } = f;
  const before = structuredClone(f.disk());
  const input = d.composerDrafts.read("new");
  expect(d.composerDrafts.movePreparedToSession("owned", input)).toBe(true);
  f.fail(true);
  await expect(d.draftPersistence.flush()).rejects.toThrow();
  expect(f.disk()).toEqual(before);
  expect(d.composerDrafts.read("session:owned")).toBe(input);
  expect(d.draftPersistence.snapshot().error).not.toBeNull();
  f.fail(false);
  await d.draftPersistence.flush();
  expect((f.disk() as { composers: object }).composers).not.toHaveProperty(
    "new",
  );
  expect(f.disk()).toMatchObject({ composers: { "session:owned": input } });
});

it("refuses a stale input snapshot and an existing destination without publishing or erasing either value", async () => {
  const { d } = await fixture();
  const old = d.composerDrafts.read("new");
  d.composerDrafts.update("new", (input) => ({ ...input, text: "latest" }));
  const latest = d.composerDrafts.read("new");
  expect(d.composerDrafts.movePreparedToSession("owned", old)).toBe(false);
  d.composerDrafts.update("session:owned", () => ({
    text: "existing",
    attachments: [],
  }));
  const destination = d.composerDrafts.read("session:owned");
  const revision = d.composerDrafts.revision();
  expect(d.composerDrafts.movePreparedToSession("owned", latest)).toBe(false);
  expect(d.composerDrafts.revision()).toBe(revision);
  expect(d.composerDrafts.read("new")).toBe(latest);
  expect(d.composerDrafts.read("session:owned")).toBe(destination);
});
