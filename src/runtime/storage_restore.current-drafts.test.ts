import { beforeEach, expect, it, vi } from "vitest";
import { audioAttachment } from "./audio_input.test-support";
import { documentAttachment } from "./docx_draft.test-support";
import { workbookAttachment } from "./xlsx_draft.test-support";
import { approvedPdf, PDF_URI } from "./pdf_document.test-support";
import type { DraftAttachment } from "./drafts";
import { AUDIO_INPUT } from "./audio_input";
import { DOCUMENT_INPUT_STRINGS } from "./document_input_strings";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

beforeEach(() => {
  vi.resetModules();
  h.invoke.mockReset().mockResolvedValue(null);
});

// Capture the production settings serializer and prompt builder, so adding a
// supported attachment cannot leave recovery's independently written fixture green.
async function savedInput(
  kind: "audio" | "document" | "xlsx" | "pdf" | "both",
  location: "composer" | "queue" | "editor" | "all",
) {
  const d = await import("./drafts");
  const { attachmentPromptBlocks } = await import("./draft_attachments");
  await d.draftPersistence.load();
  const attachments: DraftAttachment[] =
    kind === "audio"
      ? [audioAttachment()]
      : kind === "document"
        ? [documentAttachment()]
        : kind === "xlsx"
          ? [workbookAttachment()]
          : kind === "pdf"
            ? [
                {
                  id: "pdf",
                  kind: "file",
                  name: "complete.pdf",
                  uri: PDF_URI,
                  documentText: approvedPdf(),
                },
              ]
            : [audioAttachment(), documentAttachment()];
  const blocks = attachmentPromptBlocks(
    "Keep original input",
    attachments,
    true,
  );
  const choice = {
    agentId: "selected",
    cwd: "/owned",
    config: { "official.future.option": "chosen" },
    service: { id: "service", model: "model", revision: "revision" },
    reviewRequired: true,
  };
  Object.assign(d.newConversationChoice, choice);
  d.composerDrafts.update("new", () => ({
    text: "Keep original input",
    attachments:
      location === "composer" || location === "all" ? attachments : [],
    sendPending: true,
    savedChoice: choice,
    pendingConversation: {
      agentId: "selected",
      cwd: "/owned",
      nativeSessionId: "original",
      service: { id: "service", model: "model" },
      serviceRevision: "revision",
    },
  }));
  if (location === "queue" || location === "all")
    d.draftQueues.write("thread", [blocks], 0, true);
  if (location === "editor" || location === "all")
    d.composerDrafts.update("queue-edit:thread", () => ({
      text: "Edited input",
      attachments: [],
      queueEdit: { index: 0, original: blocks },
    }));
  await d.draftPersistence.flush();
  const saved: unknown = h.invoke.mock.calls
    .filter(
      ([command, args]) =>
        command === "settings_set" && args.key === "unsentWork.v1",
    )
    .at(-1)![1].value;
  h.invoke.mockClear();
  return { d, saved, blocks, attachments };
}

async function preview(value: unknown) {
  const { previewEntries } = await import("./storage_restore");
  return previewEntries(
    {
      id: "a".repeat(48),
      sourcePath: "/copy",
      values: { "unsentWork.v1": JSON.stringify(value), "agentSetup.v1": null },
    },
    ["unsentWork.v1"],
  )[0];
}

it.each([
  ["audio", "composer"],
  ["audio", "queue"],
  ["audio", "editor"],
  ["document", "composer"],
  ["document", "queue"],
  ["document", "editor"],
  ["xlsx", "all"],
  ["pdf", "all"],
  ["both", "all"],
] as const)(
  "recovers the production %s snapshot in %s without reading files or sending",
  async (kind, location) => {
    const { d, saved, blocks, attachments } = await savedInput(kind, location);
    const before = d.composerDrafts.read("new");
    const parsed = d.parseDraftSnapshot(saved)!;
    if (kind === "both")
      expect(saved).toHaveProperty("audioEncoding.version", 1);
    expect(await preview(saved)).toMatchObject({ valid: true, empty: false });
    expect(d.parseDraftSnapshot(saved, "recovery")).toEqual(parsed);
    expect(d.composerDrafts.read("new")).toBe(before);
    expect(h.invoke).not.toHaveBeenCalled();

    vi.resetModules();
    h.invoke.mockResolvedValue(structuredClone(saved));
    const cold = await import("./drafts");
    await cold.draftPersistence.load();
    expect(cold.composerDrafts.read("new")).toEqual(
      parsed.composers.find(([key]) => key === "new")![1],
    );
    expect(cold.composerDrafts.read("new")).toMatchObject({
      sendPending: true,
      pendingConversation: before.pendingConversation,
      savedChoice: before.savedChoice,
    });
    if (location === "composer" || location === "all")
      expect(cold.composerDrafts.read("new").attachments).toEqual(
        attachments.map((attachment) => ({ ...attachment, recovered: true })),
      );
    if (location === "queue" || location === "all")
      expect(cold.draftQueues.read("thread")).toEqual({
        blocks: [blocks],
        uncertainIndex: 0,
        outcomeUnknown: true,
      });
    if (location === "editor" || location === "all")
      expect(cold.composerDrafts.read("queue-edit:thread").queueEdit).toEqual({
        index: 0,
        original: blocks,
      });
    expect(h.invoke.mock.calls.map(([command]) => command)).toEqual([
      "settings_get",
    ]);
    h.invoke.mockClear();
    const { prepareDraftAttachments } = await import("./draft_attachments");
    for (const attachment of cold.composerDrafts.read("new").attachments)
      await expect(prepareDraftAttachments([attachment], true)).rejects.toThrow(
        attachment.kind === "audio"
          ? AUDIO_INPUT.recoveryRequired
          : DOCUMENT_INPUT_STRINGS.recoveryRequired,
      );
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

function recordAt(value: unknown, path: string[]) {
  let target = value as Record<string, unknown>;
  for (const key of path) target = target[key] as Record<string, unknown>;
  return target;
}

it.each([
  [],
  ["choice"],
  ["choice", "service"],
  ["composers", "new"],
  ["composers", "new", "savedChoice"],
  ["composers", "new", "savedChoice", "service"],
  ["composers", "new", "pendingConversation"],
  ["composers", "new", "pendingConversation", "service"],
  ["composers", "new", "attachments", "0"],
  ["composers", "new", "attachments", "0", "localAudio"],
  ["composers", "new", "attachments", "0", "localAudio", "file"],
  ["composers", "new", "attachments", "1", "documentText"],
  ["composers", "new", "attachments", "1", "documentText", "local"],
  ["composers", "new", "attachments", "1", "documentText", "local", "source"],
  ["composers", "queue-edit:thread", "queueEdit"],
  ["composers", "queue-edit:thread", "queueEdit", "original", "1"],
  ["queues", "thread"],
  ["queues", "thread", "blocks", "0", "0"],
  ["queues", "thread", "blocks", "0", "1", "localAudio"],
  ["queues", "thread", "blocks", "0", "1", "localAudio", "file"],
  ["queues", "thread", "blocks", "0", "2", "resource"],
  ["queues", "thread", "blocks", "0", "2", "localDocumentText"],
  ["audioEncoding"],
])(
  "refuses a future field at %j without hydrating or writing",
  async (...path) => {
    const { d, saved } = await savedInput("both", "all");
    const changed = structuredClone(saved);
    recordAt(changed, path).futureInput = { text: "must not be discarded" };
    const before = d.composerDrafts.read("new");
    expect(await preview(changed)).toMatchObject({ valid: false });
    expect(d.composerDrafts.read("new")).toBe(before);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("retains classification failures and does not treat recovery as attachment approval", async () => {
  const { d } = await savedInput("audio", "composer");
  d.composerDrafts.update("new", (draft) => ({
    ...draft,
    attachments: draft.attachments.map((a) => ({
      ...a,
      audioClassificationFailed: true,
      imageClassificationFailed: true,
    })),
  }));
  await d.draftPersistence.flush();
  const saved = h.invoke.mock.calls
    .filter(([command]) => command === "settings_set")
    .at(-1)![1].value;
  h.invoke.mockClear();
  expect(await preview(saved)).toMatchObject({ valid: true });
  const attachment =
    d.parseDraftSnapshot(saved)!.composers[0][1].attachments[0];
  expect(attachment).toMatchObject({
    recovered: true,
    audioClassificationFailed: true,
    imageClassificationFailed: true,
  });
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each([null, {}, { file: { path: "/private/arbitrary.wav" } }])(
  "preserves known legacy audio bytes with source %j without granting file access",
  async (source) => {
    const { d, saved } = await savedInput("audio", "composer");
    recordAt(saved, ["composers", "new", "attachments", "0"]).localAudio =
      source;
    expect(await preview(saved)).toMatchObject({ valid: true });
    const parsed = d.parseDraftSnapshot(saved, "recovery")!;
    expect(parsed.composers[0][1].attachments[0]).toMatchObject({
      data: audioAttachment().data,
      localAudio: null,
      recovered: true,
    });
    expect(parsed.composers[0][1].attachments[0].uri).toBeUndefined();
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it("keeps ordinary-load compatibility without accepting unknown recovery send metadata", async () => {
  const { d, saved } = await savedInput("audio", "queue");
  recordAt(saved, ["queues", "thread", "blocks", "0", "0"])._meta = {
    "official.future": { retained: true },
  };
  expect(d.parseDraftSnapshot(saved)!.queues[0][1].blocks[0][0]).toHaveProperty(
    ["_meta", "official.future"],
    { retained: true },
  );
  expect(await preview(saved)).toMatchObject({ valid: false });
  expect(h.invoke).not.toHaveBeenCalled();
});

it.each(["content", "loading", "recovered", "imageChecked"])(
  "retains legacy %s loading rules while recovery continues to reject transient fields",
  async (field) => {
    const { d, saved } = await savedInput("audio", "composer");
    recordAt(saved, ["composers", "new", "attachments", "0"])[field] = true;
    expect(
      d.parseDraftSnapshot(saved)!.composers[0][1].attachments[0],
    ).toMatchObject({
      data: audioAttachment().data,
      recovered: true,
    });
    expect(await preview(saved)).toMatchObject({ valid: false });
    expect(h.invoke).not.toHaveBeenCalled();
  },
);

it.each([
  { path: ["audioEncoding", "version"], value: 99 },
  {
    path: ["composers", "new", "attachments", "0", "data"],
    value: { audioRef: 99 },
  },
  {
    path: ["queues", "thread", "blocks", "0", "1", "localAudio", "sampleRate"],
    value: 0,
  },
  {
    path: ["queues", "thread", "blocks", "0", "1", "uri"],
    value: { path: "/private/arbitrary.wav" },
  },
  {
    path: [
      "queues",
      "thread",
      "blocks",
      "0",
      "2",
      "localDocumentText",
      "format",
    ],
    value: "future",
  },
  {
    path: ["composers", "new", "attachments", "0", "audioClassificationFailed"],
    value: "no",
  },
  {
    path: ["composers", "new", "attachments", "1", "localAudio"],
    value: audioAttachment().localAudio,
  },
])(
  "refuses malformed current data at $path as a whole",
  async ({ path, value }) => {
    const { d, saved } = await savedInput("both", "all");
    const before = d.composerDrafts.read("new");
    recordAt(saved, path.slice(0, -1))[path.at(-1)!] = value;
    expect(await preview(saved)).toMatchObject({ valid: false });
    expect(d.composerDrafts.read("new")).toBe(before);
    expect(h.invoke).not.toHaveBeenCalled();
  },
);
