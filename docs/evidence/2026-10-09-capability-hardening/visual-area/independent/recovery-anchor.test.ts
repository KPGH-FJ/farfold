import { beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.invoke }));
import {
  composerDrafts,
  parseDraftSnapshot,
} from "../../../../../src/runtime/drafts";
import { previewEntries } from "../../../../../src/runtime/storage_restore";
const path = "/controlled/old-page.pdf";
const contentId = `disk:${JSON.stringify([path, "fixture-v1", "a".repeat(64)])}`;
const snapshot = (anchor: unknown) => ({
  version: 1,
  composers: { new: { text: "Keep this original composer", attachments: [] } },
  choice: { agentId: null, cwd: null, service: null, config: {} },
  feedback: {
    thread: {
      original: {
        path,
        contentId,
        scope: "file",
        selection: null,
        text: "Keep this exact opinion",
        anchor,
      },
    },
  },
  queues: {
    thread: {
      blocks: [[{ type: "text", text: "Keep this queued work" }]],
      uncertainIndex: 0,
    },
  },
});
const receipt = (raw: string) => ({
  id: "a".repeat(48),
  sourcePath: "/controlled/read-only-copy.sqlite3",
  values: { "unsentWork.v1": raw, "agentSetup.v1": null },
});
beforeEach(() => calls.invoke.mockClear());
it("offers the same valid existing PDF page opinion in recovery as in normal cold parsing, without publishing or IO", () => {
  const anchor = { kind: "pdf-page", page: 2, pageCount: 4 };
  const value = snapshot(anchor);
  const raw = JSON.stringify(value);
  const current = composerDrafts.read("new");
  const parsed = parseDraftSnapshot(value)!;
  expect(Object.values(parsed.feedback[0][1])[0].anchor).toEqual(anchor);
  expect(parsed.composers[0][1].text).toBe("Keep this original composer");
  const preview = receipt(raw);
  const entries = previewEntries(preview, ["unsentWork.v1"]);
  expect(preview.values["unsentWork.v1"]).toBe(raw);
  expect(composerDrafts.read("new")).toBe(current);
  expect(calls.invoke).not.toHaveBeenCalled();
  expect(entries[0].valid).toBe(true);
});
it("rejects a malformed anchored snapshot whole and keeps its raw bytes and current draft", () => {
  const value = snapshot({
    kind: "pdf-page",
    page: 2,
    pageCount: 4,
    futureLocation: 1,
  });
  const raw = JSON.stringify(value);
  const current = composerDrafts.read("new");
  expect(() => parseDraftSnapshot(value)).toThrow();
  const preview = receipt(raw);
  expect(previewEntries(preview, ["unsentWork.v1"])[0].valid).toBe(false);
  expect(preview.values["unsentWork.v1"]).toBe(raw);
  expect(composerDrafts.read("new")).toBe(current);
  expect(calls.invoke).not.toHaveBeenCalled();
});
