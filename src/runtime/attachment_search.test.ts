import { describe, it, expect, vi } from "vitest";
import { setup, deferred, tick } from "./attachment_search.test-support";
import {
  attachmentSearchCandidates,
  attachmentSearchSourceCurrent,
} from "./attachment_search_source";
import { validAttachmentSearchQuery } from "./attachment_search";
import type { VerifiedFile } from "./file_delivery";

describe("explicit current attachment text search", () => {
  it("enumerates only explicit loaded message attachments without reads", () => {
    const h = setup();
    h.s.items.push({
      kind: "thought",
      id: "thought",
      text: "file:///secret",
      time: 0,
      streaming: false,
    });
    h.s.items.push({
      kind: "tool",
      id: "tool",
      call: {
        toolCallId: "t",
        kind: "read",
        name: "read",
        title: "x",
        status: "completed",
        content: [{ type: "link", uri: "file:///secret", name: "x" }],
        locations: [],
        startedAt: 0,
      },
    });
    const r = attachmentSearchCandidates(["saved", "cold"], h.states);
    expect(r.candidates).toHaveLength(2);
    expect(r.unloaded).toBe(1);
    expect(h.services.inspect).not.toHaveBeenCalled();
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it.each([
    "https://host/file.txt",
    "file://host/file.txt",
    "/fixture/file.txt",
    "file:///fixture/a?secret=x",
    "data:text/plain,hello",
  ])("never turns unapproved URI %s into local read", async (uri) => {
    const h = setup();
    const item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0].uri = uri;
    const candidates = attachmentSearchCandidates(
      ["saved"],
      h.states,
    ).candidates;
    expect(candidates[0].path).toBeNull();
    await h.search.start("needle", [candidates[0]], () => true);
    expect(h.services.inspect).not.toHaveBeenCalled();
  });
  it("rejects fabricated candidates even if a caller supplies true ownership", async () => {
    const h = setup();
    await h.search.start(
      "needle",
      [{ ...h.candidates[0], path: "/secret/passwords" }],
      () => true,
    );
    expect(h.services.inspect).not.toHaveBeenCalled();
  });
  it("searches exact selected complete file text and retains real source separately", async () => {
    const h = setup();
    await h.search.start("needle", [h.candidates[1]], h.current);
    expect(h.services.inspect).toHaveBeenCalledExactlyOnceWith(
      "/fixture/file1.txt",
    );
    expect(h.search.snapshot()).toMatchObject({
      phase: "complete",
      matches: 1,
      bytes: 14,
    });
    expect(h.search.snapshot().hits[0]).toMatchObject({
      source: h.candidates[1],
      before: "another ",
      match: "needle",
    });
    expect(h.search.snapshot().hits[0]).not.toHaveProperty("messageOffset");
  });
  it.each([
    "root",
    "path",
    "resolvedPath",
    "name",
    "size",
    "sha256",
    "version",
  ])("rejects %s mismatch in read receipt", async (key) => {
    const h = setup();
    h.services.read.mockImplementation(async (f) => ({
      file: { ...f, [key]: key === "size" ? f.size + 1 : "changed" },
      text: h.bodies.get(f.path)!,
    }));
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.search.snapshot().rows.every((r) => r.state === "error")).toBe(
      true,
    );
  });
  it("rejects same-size replacement text even with copied metadata", async () => {
    const h = setup(["needle"]);
    h.services.read.mockResolvedValue({
      file: h.files.values().next().value!,
      text: "secret",
    });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("changed");
  });
  it("checks content revision before publishing and navigation", async () => {
    const h = setup();
    await h.search.start("needle", h.candidates, h.current);
    const hit = h.search.snapshot().hits[0];
    h.services.check.mockResolvedValue({
      kind: "verified",
      file: { ...hit.file, version: "later" },
    });
    expect(await h.search.verifyHit(hit, h.current)).toBe(false);
  });
  it.each([
    ["此文件无法作为文字预览，请另存或使用其他应用打开", "unsupported"],
    ["文件或位置已变化，请重新检查", "changed"],
    ["文件超过当前操作的大小限制", "tooLarge"],
  ])("classifies actual readText failure %s", async (message, code) => {
    const h = setup();
    h.services.read.mockRejectedValue(message);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe(code);
  });
  it("preserves literal regex metacharacters and Unicode snippets", async () => {
    const h = setup(["😀 alpha .* 😀 τέλος .* end"]);
    await h.search.start(".*", h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(2);
    expect(h.search.snapshot().hits[0].match).toBe(".*");
    expect(validAttachmentSearchQuery("😀")).toBe(true);
  });
  it.each(["", "\u0000", "x".repeat(257), "\ud800"])(
    "rejects invalid bounded query",
    async (query) => {
      const h = setup();
      await h.search.start(query, h.candidates, h.current);
      expect(h.services.inspect).not.toHaveBeenCalled();
    },
  );
  it("separately reports nontext NUL", async () => {
    const h = setup(["needle\0bytes"]);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("unsupported");
  });
  it("counts all matches but displays only200", async () => {
    const h = setup(["needle ".repeat(250)]);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(250);
    expect(h.search.snapshot().hits).toHaveLength(200);
  });
  it("does not read text over1MiB after inspect", async () => {
    const h = setup(["x".repeat(1024 * 1024 + 1)]);
    await h.search.start("x", h.candidates, h.current);
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().rows[0].code).toBe("tooLarge");
  });
  it("admits exactly16MiB full bytes in selection order and omits excess", async () => {
    const h = setup(
      Array.from({ length: 17 }, () => "needle" + "x".repeat(1024 * 1024 - 6)),
    );
    await h.search.start("needle", h.candidates, h.current);
    expect(h.services.read).toHaveBeenCalledTimes(16);
    expect(h.search.snapshot()).toMatchObject({
      matches: 16,
      bytes: 16 * 1024 * 1024,
    });
    expect(h.search.snapshot().rows[16]).toMatchObject({
      state: "skipped",
      code: "budget",
    });
  });
  it("max20 and duplicate declarations are rejected before any read", async () => {
    const h = setup(Array(21).fill("needle"));
    await h.search.start("needle", h.candidates, h.current);
    await h.search.start(
      "needle",
      [h.candidates[0], h.candidates[0]],
      h.current,
    );
    expect(h.services.inspect).not.toHaveBeenCalled();
  });
  it("keeps at most2 checks and prevents overlapping cancelled runs", async () => {
    const h = setup(Array(4).fill("needle"));
    const a = deferred<VerifiedFile>(),
      b = deferred<VerifiedFile>();
    h.services.inspect
      .mockImplementationOnce(() => a.promise)
      .mockImplementationOnce(() => b.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    expect(h.services.inspect).toHaveBeenCalledTimes(2);
    h.search.cancel();
    expect(h.search.snapshot().phase).toBe("cancelling");
    expect(await h.search.start("needle", h.candidates, h.current)).toBe(false);
    a.resolve(h.files.get(h.candidates[0].path!)!);
    b.resolve(h.files.get(h.candidates[1].path!)!);
    await run;
    expect(h.services.inspect).toHaveBeenCalledTimes(2);
    expect(h.services.read).not.toHaveBeenCalled();
    expect(h.search.snapshot().phase).toBe("cancelled");
  });
  it("rejects late read after source replacement without editing the message", async () => {
    const h = setup(["needle"]),
      pending = deferred<{ file: VerifiedFile; text: string }>();
    h.services.read.mockImplementation(() => pending.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    await tick();
    const item = h.s.items[0];
    if (item.kind !== "user") throw Error();
    item.attachments[0] = { ...item.attachments[0] };
    pending.resolve({ file: h.files.values().next().value!, text: "needle" });
    await run;
    expect(h.search.snapshot().phase).toBe("stale");
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.check).not.toHaveBeenCalled();
  });
  it("pending is never retried automatically but an explicit start can retry against the real pool", async () => {
    const h = setup(["needle"]);
    h.services.inspect.mockRejectedValueOnce({ code: "pending" });
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().phase).toBe("pending");
    expect(h.services.read).not.toHaveBeenCalled();
    h.search.retire();
    await tick();
    expect(h.services.inspect).toHaveBeenCalledTimes(1);
    expect(h.search.snapshot().phase).toBe("pending");
    await h.search.start("needle", h.candidates, h.current);
    expect(h.services.inspect).toHaveBeenCalledTimes(2);
    expect(h.search.snapshot()).toMatchObject({
      phase: "complete",
      matches: 1,
      previousPending: true,
    });
  });
  it("explicit retry cannot turn a still busy backend into successful completion", async () => {
    const h = setup(["needle"]);
    h.services.inspect
      .mockRejectedValueOnce({ code: "pending" })
      .mockRejectedValueOnce({ code: "busy" });
    await h.search.start("needle", h.candidates, h.current);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().rows[0].code).toBe("busy");
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.services.read).not.toHaveBeenCalled();
  });
  it("retired ownership releases displayed text and suppresses late hits", async () => {
    const h = setup(),
      pending = deferred<VerifiedFile>();
    h.services.inspect.mockImplementation(() => pending.promise);
    const run = h.search.start("needle", h.candidates, h.current);
    h.search.retire();
    pending.resolve(h.files.get(h.candidates[0].path!)!);
    await run;
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.search.snapshot().rows).toEqual([]);
  });
  it("source identity cannot be revived by replacing a thread with equal fields", () => {
    const h = setup();
    h.states.set("saved", { ...h.s });
    expect(attachmentSearchSourceCurrent(h.candidates[0], h.states)).toBe(
      false,
    );
  });
  it("serializes navigation verification with subsequent reads", async () => {
    const h = setup(["needle"]);
    await h.search.start("needle", h.candidates, h.current);
    const pending = deferred<{ kind: string; file: VerifiedFile }>();
    h.services.check.mockImplementation(() => pending.promise);
    const hit = h.search.snapshot().hits[0],
      nav = h.search.verifyHit(hit, h.current);
    expect(await h.search.verifyHit(hit, h.current)).toBe(false);
    expect(await h.search.start("needle", h.candidates, h.current)).toBe(false);
    pending.resolve({ kind: "verified", file: hit.file });
    expect(await nav).toBe(true);
  });
  it("pending navigation preserves uncertainty until an explicit retry", async () => {
    const h = setup(["needle"]);
    await h.search.start("needle", h.candidates, h.current);
    h.services.check.mockRejectedValue({ code: "pending" });
    expect(
      await h.search.verifyHit(h.search.snapshot().hits[0], h.current),
    ).toBe(false);
    expect(h.search.snapshot().phase).toBe("pending");
    h.services.check.mockImplementation(async (file) => ({
      kind: "verified",
      file,
    }));
    expect(await h.search.start("needle", h.candidates, h.current)).toBe(true);
  });
  it("abort during match enumeration yields and suppresses the partial result", async () => {
    const h = setup(["n".repeat(20000)]);
    let current = true;
    const run = h.search.start("n", h.candidates, () => current);
    setTimeout(() => {
      current = false;
    }, 0);
    await run;
    expect(h.search.snapshot().hits).toEqual([]);
    expect(h.search.snapshot().phase).toBe("stale");
  });
  it("notifies subscribers after a successful navigation returns to idle admission", async () => {
    const h = setup(["needle"]);
    await h.search.start("needle", h.candidates, h.current);
    const observed: boolean[] = [];
    h.search.subscribe(() => observed.push(h.search.busy()));
    await h.search.verifyHit(h.search.snapshot().hits[0], h.current);
    expect(observed).toEqual([true, false]);
  });

  it.each(["agentId", "cwd", "nativeSessionId"])(
    "same-key index %s mismatch invalidates ownership while equal refresh remains valid",
    (key) => {
      const h = setup();
      const row = {
        id: h.s.key,
        agentId: h.s.agentId,
        cwd: h.s.cwd,
        nativeSessionId: h.s.nativeSessionId,
      };
      expect(
        attachmentSearchSourceCurrent(
          h.candidates[0],
          h.states,
          [h.s.key],
          [{ ...row }],
        ),
      ).toBe(true);
      expect(
        attachmentSearchSourceCurrent(
          h.candidates[0],
          h.states,
          [h.s.key],
          [{ ...row, [key]: "changed" }],
        ),
      ).toBe(false);
    },
  );
  it.each(["changed", "unreadable"])(
    "navigation %s invalidates visible snippets with an accurate error",
    async (code) => {
      const h = setup(["needle"]);
      await h.search.start("needle", h.candidates, h.current);
      h.services.check.mockRejectedValue({ code });
      expect(
        await h.search.verifyHit(h.search.snapshot().hits[0], h.current),
      ).toBe(false);
      expect(h.search.snapshot()).toMatchObject({
        phase: "stale",
        hits: [],
        error: code,
      });
    },
  );
  it("raw UTF8 search does not pretend to parse an ASCII-only document", async () => {
    const h = setup(["%PDF-1.4\nneedle\n%%EOF"]);
    await h.search.start("needle", h.candidates, h.current);
    expect(h.search.snapshot().matches).toBe(1);
  });
  it("retiring a failed navigation does not carry its source error into a new scope", async () => {
    const h = setup(["needle"]);
    await h.search.start("needle", h.candidates, h.current);
    h.services.check.mockRejectedValue({ code: "unreadable" });
    await h.search.verifyHit(h.search.snapshot().hits[0], h.current);
    expect(h.search.snapshot().error).toBe("unreadable");
    h.search.retire();
    expect(h.search.snapshot().error).toBeUndefined();
  });
});
