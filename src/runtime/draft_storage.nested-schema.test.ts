import { beforeEach, expect, it, vi } from "vitest";
import { audioAttachment } from "./audio_input.test-support";

const mock = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mock.invoke }));
beforeEach(() => {
  vi.resetModules();
  mock.invoke.mockReset();
});

function original() {
  return {
    version: 1,
    composers: {
      "session:previous": {
        text: "keep previous",
        attachments: [audioAttachment()],
      },
    },
    choice: { agentId: "a", cwd: "/work", service: null, config: {} },
    feedback: {},
    queues: {},
    activity: { previous: { lastActivityAt: 1, ended: false } },
  };
}

it.each(["localAudio", "localAudio.file", "activity"])(
  "preserves unknown %s fields through failed hydration and save, then retains local input on a supported retry",
  async (location) => {
    let disk = original();
    const audio = disk.composers["session:previous"].attachments[0];
    const target =
      location === "localAudio"
        ? audio.localAudio!
        : location === "localAudio.file"
          ? audio.localAudio!.file
          : disk.activity.previous;
    Object.assign(target, { futureInput: { text: "retain unknown input" } });
    const captured = structuredClone(disk);
    mock.invoke.mockImplementation(async (command, input) => {
      if (command === "settings_get") return structuredClone(disk);
      if (command === "settings_set") disk = structuredClone(input.value);
    });
    const d = await import("./drafts");
    const reading = await Promise.allSettled([d.draftPersistence.load()]);
    d.composerDrafts.update("new", () => ({
      text: "keep later local input",
      attachments: [],
    }));
    const flushing = await Promise.allSettled([d.draftPersistence.flush()]);
    expect(disk).toEqual(captured);
    expect(reading[0].status).toBe("rejected");
    expect(flushing[0].status).toBe("rejected");
    expect(d.draftPersistence.snapshot().ready).toBe(false);
    expect(d.composerDrafts.read("session:previous").text).toBe("");
    expect(d.composerDrafts.read("new").text).toBe("keep later local input");
    expect(
      mock.invoke.mock.calls.every(([command]) => command === "settings_get"),
    ).toBe(true);

    disk = original();
    await d.draftPersistence.load();
    await d.draftPersistence.flush();
    expect(d.draftPersistence.snapshot().ready).toBe(true);
    expect(d.composerDrafts.read("new").text).toBe("keep later local input");
    expect(d.composerDrafts.read("session:previous")).toMatchObject(
      original().composers["session:previous"],
    );
    expect(disk).toMatchObject({
      composers: {
        new: { text: "keep later local input" },
        "session:previous": original().composers["session:previous"],
      },
      activity: original().activity,
    });
    expect(
      mock.invoke.mock.calls.every(([command]) =>
        ["settings_get", "settings_set"].includes(command),
      ),
    ).toBe(true);
  },
);

it.each([null, {}, { file: { path: "/private/arbitrary.wav" } }])(
  "keeps legacy missing or malformed audio source %j read-only while retaining its bytes",
  async (source) => {
    let disk = original();
    const attachment = disk.composers["session:previous"].attachments[0];
    Object.assign(attachment, { localAudio: source });
    mock.invoke.mockImplementation(async (command, input) => {
      if (command === "settings_get") return structuredClone(disk);
      if (command === "settings_set") disk = structuredClone(input.value);
    });
    const d = await import("./drafts");
    await d.draftPersistence.load();
    const recovered = d.composerDrafts.read("session:previous").attachments[0];
    expect(recovered).toMatchObject({
      id: attachment.id,
      data: attachment.data,
      mimeType: attachment.mimeType,
      localAudio: null,
      recovered: true,
    });
    expect(recovered.uri).toBeUndefined();
    expect(mock.invoke.mock.calls.map(([command]) => command)).toEqual([
      "settings_get",
    ]);
    d.composerDrafts.update("new", () => ({ text: "later", attachments: [] }));
    await d.draftPersistence.flush();
    expect(disk.composers["session:previous"].attachments[0]).toMatchObject({
      data: attachment.data,
      localAudio: null,
    });
    expect(
      disk.composers["session:previous"].attachments[0].uri,
    ).toBeUndefined();
    expect(
      mock.invoke.mock.calls.every(([command]) =>
        ["settings_get", "settings_set"].includes(command),
      ),
    ).toBe(true);
  },
);

it("retains arbitrary official Agent configuration option names across restore and save", async () => {
  let disk = original();
  const config = { "future.agent.option": "retain", enabled: true, count: 3 };
  disk.choice.config = config;
  mock.invoke.mockImplementation(async (command, input) => {
    if (command === "settings_get") return structuredClone(disk);
    if (command === "settings_set") disk = structuredClone(input.value);
  });
  const d = await import("./drafts");
  await d.draftPersistence.load();
  expect(d.newConversationChoice.config).toEqual(config);
  d.composerDrafts.update("new", () => ({ text: "later", attachments: [] }));
  await d.draftPersistence.flush();
  expect(disk.choice.config).toEqual(config);
});
