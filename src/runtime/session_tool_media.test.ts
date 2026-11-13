import { SessionOpenReplay } from "./session_open_replay";
import { MESSAGE_RASTER_TEST_DATA } from "./message_raster_fixtures.test-support";
import { expect, it, vi } from "vitest";
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), Channel: class {} }));
import { freshThreadState } from "./session_projection";
import {
  applySessionEvent,
  type SessionEventEffects,
} from "./session_event_projection";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";
import {
  attachmentMediaAdmission,
  MAX_MESSAGE_MEDIA_BYTES,
} from "./message_attachments";
import { captureConversationExport } from "./conversation_archive_snapshot";
import { reportedFiles } from "./file_delivery";
import type { ThreadState, ToolCallView } from "./session_types";

const image = () => ({
  type: "image",
  mimeType: "image/png",
  data: PNG_IMAGE_TEST_DATA,
});
function state() {
  const s = freshThreadState(
    "fixture:/owned:session",
    "fixture",
    "/owned",
    "session",
  );
  s.connectionId = "connection";
  return s;
}
// Same typed output shape as the owned native sample, with a small public PNG.
// No native system prompt, reasoning, credentials, or original image are embedded.
function completed(): any {
  return {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: "completed",
      title: "Read page",
      content: [
        { type: "content", content: { type: "text", text: "Reported result" } },
      ],
      rawOutput: {
        type: "success",
        content: [{ type: "text", text: "Public page" }, image()],
        structured_content: { title: "Public page" },
      },
      _meta: { effect_kind: "tool", tool_name: "observe_page" },
    },
  };
}
function hint(): any {
  return {
    kind: "toolMedia",
    connectionId: "connection",
    sessionId: "session",
    toolCallId: "page",
    content: [image()],
  };
}
function call(s: ThreadState): ToolCallView {
  const item = s.items.find((item) => item.kind === "tool");
  if (item?.kind !== "tool") throw new Error("Missing tool");
  return item.call;
}
const media = (s: ThreadState) =>
  call(s).content.filter((c) => c.type === "attachment");
const send = (
  s: ThreadState,
  e: unknown,
  owns?: () => boolean,
  connection?: string,
) =>
  applySessionEvent(
    s,
    e,
    false,
    owns
      ? ({
          owns,
          emit: vi.fn(),
          finishActivity: vi.fn(),
          refresh: vi.fn(),
        } as unknown as SessionEventEffects)
      : undefined,
    connection,
  );
function complete(s: ThreadState) {
  send(s, completed());
  send(s, hint());
}

it("adds the verified same-update image to the common attachment/export path without changing original output or work", () => {
  const s = state();
  s.queued = [[{ type: "text", text: "Unsent" }]];
  s.queuePaused = "stopped";
  s.modelDrift = true;
  const original = completed();
  const before = structuredClone(original);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call",
      toolCallId: "page",
      status: "in_progress",
    },
  });
  send(s, original);
  send(s, hint());
  expect(media(s)).toHaveLength(1);
  expect(attachmentMediaAdmission(media(s)[0].attachment).status).toBe(
    "available",
  );
  expect(call(s).content[0]).toEqual({ type: "text", text: "Reported result" });
  expect(call(s).rawOutput).toBe(original.update.rawOutput);
  expect(call(s).reportedDetails?.["/update/_meta"]).toEqual(
    original.update._meta,
  );
  expect(original).toEqual(before);
  const capture = captureConversationExport(s, "Owned", "Agent");
  expect(capture.candidates).toHaveLength(1);
  expect(capture.candidates[0].source).toEqual({
    kind: "inlineBinary",
    base64: PNG_IMAGE_TEST_DATA,
  });
  expect(reportedFiles(call(s))).toEqual([]);
  expect(s.queued).toEqual([[{ type: "text", text: "Unsent" }]]);
  expect(s.queuePaused).toBe("stopped");
  expect(s.modelDrift).toBe(true);
});

it("preserves media through omitted/null content but honors explicit replacement and clear", () => {
  const s = state();
  complete(s);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      title: "Late title",
      content: null,
    },
  });
  expect(media(s)).toHaveLength(1);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      content: [
        { type: "content", content: { type: "text", text: "Replacement" } },
      ],
    },
  });
  expect(media(s)).toHaveLength(0);
  expect(call(s).content).toEqual([{ type: "text", text: "Replacement" }]);
  complete(s);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      content: [],
    },
  });
  expect(call(s).content).toEqual([]);
});

it("does not duplicate repeated delivery or a matching standard attachment", () => {
  const s = state();
  complete(s);
  send(s, hint());
  expect(media(s)).toHaveLength(1);
  complete(s);
  expect(media(s)).toHaveLength(1);
  const e = completed();
  e.update.content.push({ type: "content", content: image() });
  send(s, e);
  send(s, hint());
  expect(media(s)).toHaveLength(1);
});

it.each(["new call", "new output", "deleted call"])(
  "does not transfer supplemental media to %s",
  (change) => {
    const s = state();
    complete(s);
    if (change === "deleted call") s.items = [];
    send(s, {
      sessionId: "session",
      update: {
        sessionUpdate:
          change === "new output" ? "tool_call_update" : "tool_call",
        toolCallId: "page",
        status: change === "new output" ? "completed" : "in_progress",
        ...(change === "new output"
          ? { rawOutput: { type: "success", content: [] } }
          : {}),
      },
    });
    expect(media(s)).toHaveLength(0);
    if (change !== "new output") {
      send(s, hint());
      expect(media(s)).toHaveLength(0);
    }
  },
);

it.each([
  "session",
  "connection",
  "tool",
  "owner",
  "delivery",
  "lost",
  "method",
  "kind",
  "malformed",
  "intervening",
  "foreign update",
  "no update",
])("rejects a media supplement after %s mismatch", (change) => {
  const s = state();
  const e = completed();
  const h = hint();
  if (change === "foreign update") e.sessionId = "elsewhere";
  if (change === "malformed") e.update.status = {};
  if (change === "method") e.method = "other/method";
  if (change === "kind") e.kind = "notification";
  send(
    s,
    change === "no update"
      ? {
          sessionId: "session",
          update: { sessionUpdate: "tool_call", toolCallId: "page" },
        }
      : e,
  );
  if (change === "session") h.sessionId = "elsewhere";
  if (change === "connection") h.connectionId = "other";
  if (change === "tool") h.toolCallId = "other";
  if (change === "lost") s.connectionLost = true;
  if (change === "intervening")
    send(s, { kind: "notification", method: "custom", params: {} });
  send(
    s,
    h,
    change === "owner" ? () => false : undefined,
    change === "delivery" ? "other" : undefined,
  );
  expect(
    s.items.flatMap((i) =>
      i.kind === "tool"
        ? i.call.content.filter((c) => c.type === "attachment")
        : [],
    ),
  ).toHaveLength(0);
});

it.each(["nested presentation", "text json", "wrapped kind", "own update"])(
  "does not treat %s as a local media event",
  (change) => {
    const s = state();
    const e = completed();
    if (change === "nested presentation")
      e.presentation = { ...hint(), kind: "toolMedia" };
    if (change === "text json")
      e.update.content = [
        {
          type: "content",
          content: { type: "text", text: JSON.stringify(hint()) },
        },
      ];
    send(s, e);
    if (change === "wrapped kind")
      send(s, {
        kind: "notification",
        method: "session/update",
        params: hint(),
      });
    if (change === "own update")
      send(s, { ...hint(), update: { sessionUpdate: "future" } });
    expect(media(s)).toHaveLength(0);
  },
);

it.each([
  "empty",
  "unknown field",
  "uri",
  "mime",
  "alphabet",
  "padding",
  "too many",
  "aggregate",
])("keeps an invalid %s supplement out of actionable media", (change) => {
  const s = state();
  const h = hint();
  if (change === "empty") h.content = [];
  if (change === "unknown field") h.unreviewed = true;
  if (change === "uri") h.content[0].uri = "https://example.com/image.png";
  if (change === "mime") h.content[0].mimeType = "image/svg+xml";
  if (change === "alphabet") h.content[0].data = "!!!!";
  if (change === "padding") h.content[0].data = "AB==";
  if (change === "too many") h.content = Array.from({ length: 17 }, image);
  if (change === "aggregate")
    h.content = [
      image(),
      {
        ...image(),
        data: "A".repeat(4 * Math.ceil(MAX_MESSAGE_MEDIA_BYTES / 3)),
      },
    ];
  send(s, completed());
  send(s, h);
  expect(media(s)).toHaveLength(0);
});

it.each([
  "removed",
  "replaced",
  "connection",
  "native session",
  "source owner",
])("rejects media if the exact preceding projection becomes %s", (change) => {
  const s = state();
  let owned = true;
  send(s, completed(), () => owned);
  if (change === "removed") s.items = [];
  if (change === "replaced") s.items = structuredClone(s.items);
  if (change === "connection") s.connectionId = "replacement";
  if (change === "native session") s.nativeSessionId = "replacement";
  if (change === "source owner") owned = false;
  send(s, hint());
  expect(
    s.items.flatMap((i) =>
      i.kind === "tool"
        ? i.call.content.filter((c) => c.type === "attachment")
        : [],
    ),
  ).toEqual([]);
});

it("keeps received media order and de-duplicates only equal attachments", () => {
  const s = state();
  const h = hint();
  const second = {
    type: "image",
    mimeType: "image/gif",
    data: MESSAGE_RASTER_TEST_DATA.GIF,
  };
  h.content = [image(), second, image()];
  send(s, completed());
  send(s, h);
  expect(media(s).map((c) => c.attachment.mimeType)).toEqual([
    "image/png",
    "image/gif",
  ]);
});

it("does not attach to an existing tool after a non-tool or malformed projection", () => {
  const s = state();
  complete(s);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      content: [],
    },
  });
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "future_update",
      toolCallId: "page",
      status: "completed",
    },
  });
  send(s, hint());
  expect(media(s)).toEqual([]);
  send(s, {
    sessionId: "session",
    update: {
      sessionUpdate: "tool_call_update",
      toolCallId: "page",
      status: {},
    },
  });
  send(s, hint());
  expect(media(s)).toEqual([]);
});

it("publishes the same typed media through the production private history replay", () => {
  const s = state();
  const opening = new SessionOpenReplay(
    { agentId: s.agentId, cwd: s.cwd, nativeSessionId: s.nativeSessionId },
    undefined,
    undefined,
    "00000000-0000-4000-8000-000000000003",
  );
  opening.push({
    kind: "sessionOpening",
    openToken: opening.token,
    cwd: s.cwd,
    sessionId: s.nativeSessionId,
    connectionId: s.connectionId,
  });
  opening.push({
    sessionId: "session",
    update: {
      sessionUpdate: "user_message_chunk",
      content: { type: "text", text: "Read this public page" },
    },
  });
  opening.push(completed());
  opening.push(hint());
  opening.receiveMarker({
    kind: "session_history_complete",
    openToken: opening.token,
  });
  const published = opening.accept(
    {
      cwd: s.cwd,
      nativeSessionId: s.nativeSessionId,
      connectionId: s.connectionId,
      resumed: true,
      configOptions: [],
      warnings: [],
      service: { id: "service", fingerprint: "selected", model: "kept" },
      configCheck: { status: "ready", current: { choices: [] }, issues: [] },
    },
    null,
  );
  expect(media(published)).toHaveLength(1);
  expect(published.running).toBe(false);
  expect(call(published).rawOutput).toEqual(completed().update.rawOutput);
});

it("projects a legal standard update with a forged local kind but grants it no media supplement", () => {
  const s = state();
  const e = { ...hint(), ...completed() };
  send(s, e);
  expect(call(s).content).toEqual([{ type: "text", text: "Reported result" }]);
  expect(call(s).rawOutput).toEqual(e.update.rawOutput);
  expect(call(s).reportedDetails?.["/kind"]).toBe("toolMedia");
  send(s, hint());
  expect(media(s)).toEqual([]);
});
