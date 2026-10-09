import { beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { fileDelivery } from "./file_delivery";
import { FILE_DELIVERY_STRINGS as S } from "./file_delivery_strings";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

// DeliveryError::TooLarge.message(), returned by both inspection commands.
const tooLargeWire = "文件超过当前操作的大小限制";
const inspect = {
  relative: () => fileDelivery.inspectLink("/work", "oversize-257.txt"),
  selected: () => fileDelivery.inspectLink("/work", "/chosen/oversize-257.txt"),
};

beforeEach(() => vi.mocked(invoke).mockReset());

it.each(["relative", "selected"] as const)(
  "classifies the real string-shaped %s inspection size failure without losing its safe message",
  async (kind) => {
    vi.mocked(invoke).mockRejectedValueOnce(tooLargeWire);
    const failure: unknown = await inspect[kind]().catch((error) => error);
    expect(failure).toMatchObject({ code: "tooLarge", message: tooLargeWire });
    expect(String(failure)).toBe(tooLargeWire);
    expect(invoke).toHaveBeenCalledOnce();
  },
);

it.each(["relative", "selected"] as const)(
  "preserves every other %s inspection rejection, including pending and busy",
  async (kind) => {
    for (const error of [
      S.checkWaitExpired,
      S.checkBusy,
      "unrecognized private failure",
      `${tooLargeWire}: private details`,
      new Error(tooLargeWire),
      { code: "pending" },
    ]) {
      vi.mocked(invoke).mockRejectedValueOnce(error);
      await expect(inspect[kind]()).rejects.toBe(error);
    }
  },
);

it("does not reinterpret the independently limited text or visual readers as a 256MiB inspection", async () => {
  const file = {
    root: "/work",
    path: "/work/document.pdf",
    resolvedPath: "/work/document.pdf",
    name: "document.pdf",
    size: 33 * 1024 * 1024,
    sha256: "a".repeat(64),
    version: "verified-version",
  };
  for (const read of [fileDelivery.readText, fileDelivery.readVisual]) {
    vi.mocked(invoke).mockRejectedValueOnce(tooLargeWire);
    await expect(read(file)).rejects.toBe(tooLargeWire);
  }
});
