import { afterEach, beforeEach, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: h.invoke,
  Channel: class {
    onmessage = (_: unknown) => {};
  },
}));

import { threads, type PromptBlock } from "./sessions";
import { draftPersistence, draftQueues } from "./drafts";
import { archiveActivity } from "./archive_activity";
import {
  attachmentPromptBlocks,
  prepareDraftAttachments,
} from "./draft_attachments";
import { TestImageDecoder } from "./image_fixtures.test-support";

// Owned two-pixel RGB PNGs encoded with the standard zlib/PNG container.
// The decoder peer verifies control flow, not native browser or model vision.
const BEFORE =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA8P8/AAj+Av6xMrqrAAAAAElFTkSuQmCC";
const AFTER =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAADElEQVR4nGNg+A+CAAj+Av5GJ00oAAAAAElFTkSuQmCC";
const URI = "file:///own/chosen.png";

beforeEach(() => {
  h.invoke.mockReset();
  vi.stubGlobal("Image", TestImageDecoder);
  vi.spyOn(draftPersistence, "flush").mockResolvedValue();
  vi.spyOn(archiveActivity, "begin").mockResolvedValue();
  vi.spyOn(archiveActivity, "finish").mockResolvedValue();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function scenario(name: string) {
  let fileData = BEFORE;
  let unreadable = false;
  const submitted: PromptBlock[][] = [];
  let receiptId = 0;
  h.invoke.mockImplementation(async (command: string, args) => {
    if (command === "draft_attachment_image") {
      expect(args).toEqual({ uri: URI, read: true });
      if (unreadable) throw new Error("private OS detail");
      return { data: fileData, mimeType: "image/png" };
    }
    if (command === "session_prompt") {
      args.admissionChannel.onmessage({
        receiptId: ++receiptId,
        phase: "offered",
      });
      submitted.push(structuredClone(args.content));
      return { status: "accepted" };
    }
    return command === "settings_get" ? 0 : [];
  });
  const state = threads.markOpenFailed(
    `image:/own:${name}`,
    "image",
    "/own",
    name,
    "fixture",
  );
  state.openError = null;
  state.connectionId = `connection-${name}`;
  state.configCheck = { status: "ready", issues: [], current: { choices: [] } };
  const event = (value: unknown) =>
    (
      threads as unknown as {
        applyChannelEvent: (key: string, value: unknown) => void;
      }
    ).applyChannelEvent(state.key, value);
  return {
    state,
    submitted,
    replaceFile: () => {
      fileData = AFTER;
    },
    loseFile: () => {
      unreadable = true;
    },
    finishFirst: () => {
      event({
        update: {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: "first response" },
        },
      });
      event({
        kind: "turnEnd",
        promptReceiptId: receiptId,
        stopReason: "end_turn",
      });
    },
  };
}

async function prepareImage() {
  const prepared = await prepareDraftAttachments(
    [
      {
        id: "selected",
        kind: "image",
        name: "chosen.png",
        uri: URI,
        mimeType: "image/png",
        data: BEFORE,
      },
    ],
    true,
  );
  expect(prepared[0]!.data).toBe(BEFORE);
  return attachmentPromptBlocks("queued image", prepared, true);
}

it("projects the exact newly read queued image that the real drain submits, rather than the prepare-time bytes", async () => {
  const f = scenario("changed-queued-image");
  expect(
    await threads.send(f.state.key, [{ type: "text", text: "first request" }]),
  ).toEqual({ status: "accepted" });
  const queued = await prepareImage();
  expect(await threads.send(f.state.key, queued)).toEqual({ status: "queued" });
  expect(f.submitted).toHaveLength(1);
  f.replaceFile();
  f.finishFirst();
  await vi.waitFor(() => expect(f.submitted).toHaveLength(2));
  const sent = f.submitted[1]!.find((block) => block.type === "image")!;
  expect(sent).toEqual({
    type: "image",
    data: AFTER,
    mimeType: "image/png",
    uri: URI,
  });
  const user = f.state.items.find(
    (item) => item.kind === "user" && item.text === "queued image",
  )!;
  expect(user.kind).toBe("user");
  if (user.kind !== "user") throw new Error("missing queued user item");
  expect(user.attachments).toEqual([
    {
      kind: "image",
      name: "图片",
      data: AFTER,
      mimeType: "image/png",
      uri: URI,
    },
  ]);
  expect(f.state.queued).toHaveLength(0);
  expect(
    h.invoke.mock.calls.filter(
      ([command]) => command === "draft_attachment_image",
    ),
  ).toHaveLength(2);
});

it("keeps a queued image and prior response when dispatch-time re-reading fails, without a second prompt or displayed unsent user image", async () => {
  const f = scenario("unreadable-queued-image");
  await threads.send(f.state.key, [{ type: "text", text: "first request" }]);
  const queued = await prepareImage();
  const original = structuredClone(queued);
  await threads.send(f.state.key, queued);
  f.loseFile();
  f.finishFirst();
  await vi.waitFor(() => expect(f.state.queuePaused).toBe("failed"));
  expect(f.submitted).toHaveLength(1);
  expect(f.state.queued).toEqual([original]);
  expect(draftQueues.read(f.state.key)?.blocks).toEqual([original]);
  expect(
    f.state.items.some(
      (item) => item.kind === "user" && item.text === "queued image",
    ),
  ).toBe(false);
  expect(
    f.state.items.some(
      (item) => item.kind === "agent" && item.text === "first response",
    ),
  ).toBe(true);
});
