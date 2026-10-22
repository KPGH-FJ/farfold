import { afterEach, beforeEach, expect, it, vi } from "vitest";
const calls = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: calls.invoke }));
import {
  prepareCompatibleAudio,
  audioCompatibilityAvailable,
  type CompatibleAudio,
} from "./message_audio_compatibility";
import { messageMediaBudget } from "./message_media_budget";
import { MESSAGE_ATTACHMENTS as S } from "./message_attachment_strings";

const data =
  "ZkxhQ4AAACIQABAAAAANAAANAfQA8AAAAyBq0A9H2K1PEgBbIrLKpI94//h0CAADH/cAAABK+A==";
const source = `data:audio/flac;base64,${data}`;
const hash = "219b60a0b78353e43373db25cb911cbc01fcdbbd6ba7fbb185d9e741fefe6c33";
const held: { release(): void }[] = [];
const prepared: CompatibleAudio[] = [];
let url: ReturnType<typeof vi.spyOn>;
let revoke: ReturnType<typeof vi.spyOn>;
function response() {
  const wave = Buffer.alloc(44 + 800 * 4);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(3, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(8000, 24);
  wave.writeUInt32LE(32000, 28);
  wave.writeUInt16LE(4, 32);
  wave.writeUInt16LE(32, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(wave.length - 44, 40);
  return {
    data: wave.toString("base64"),
    sourceSha256: hash,
    sampleRate: 8000,
    channels: 1,
    frames: 800,
  };
}
beforeEach(() => {
  calls.invoke.mockReset();
  url = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:owned-audio");
  revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});
afterEach(() => {
  prepared.splice(0).forEach((item) => item.dispose());
  held.splice(0).forEach((item) => item.release());
  vi.restoreAllMocks();
});
it("offers availability only for the literal platform response", async () => {
  for (const value of [false, "true", {}, true]) {
    calls.invoke.mockResolvedValueOnce(value);
    expect(await audioCompatibilityAvailable()).toBe(value === true);
  }
});
it("checks bound complete float WAVE and keeps its shared reservation until disposed", async () => {
  calls.invoke.mockResolvedValue(response());
  const value = await prepareCompatibleAudio(
    source,
    new AbortController().signal,
  );
  expect(value).not.toBeNull();
  prepared.push(value!);
  expect(calls.invoke).toHaveBeenCalledWith("audio_preview_decode", { data });
  expect(url).toHaveBeenCalledOnce();
  const other = messageMediaBudget.acquire(16 * 1024 * 1024);
  expect(other).not.toBeNull();
  held.push(other!);
  expect(messageMediaBudget.acquire(1)).toBeNull();
  value!.dispose();
  value!.dispose();
  expect(revoke).toHaveBeenCalledTimes(1);
  const freed = messageMediaBudget.acquire(1);
  expect(freed).not.toBeNull();
  held.push(freed!);
});
it.each(["hash", "frames", "nan", "header", "channel"])(
  "rejects forged %s without any object URL",
  async (field) => {
    const item = response();
    if (field === "hash") item.sourceSha256 = "0".repeat(64);
    if (field === "frames") item.frames++;
    if (field === "channel") item.channels = 3;
    if (field === "nan" || field === "header") {
      const wave = Buffer.from(item.data, "base64");
      if (field === "nan") wave.writeFloatLE(NaN, 44);
      else wave.writeUInt16LE(1, 20);
      item.data = wave.toString("base64");
    }
    calls.invoke.mockResolvedValue(item);
    await expect(
      prepareCompatibleAudio(source, new AbortController().signal),
    ).rejects.toThrow(S.audioCompatibilityFailed);
    expect(url).not.toHaveBeenCalled();
    const entire = messageMediaBudget.acquire(32 * 1024 * 1024);
    expect(entire).not.toBeNull();
    held.push(entire!);
  },
);
it("full shared capacity rejects before byte expansion or native work", async () => {
  const lease = messageMediaBudget.acquire(32 * 1024 * 1024);
  held.push(lease!);
  const expand = vi.spyOn(globalThis, "atob");
  await expect(
    prepareCompatibleAudio(source, new AbortController().signal),
  ).rejects.toThrow(S.mediaBudgetReached);
  expect(expand).not.toHaveBeenCalled();
  expect(calls.invoke).not.toHaveBeenCalled();
});
it("cancelled requests retain actual pending work reservations until each return", async () => {
  const resolves: ((value: unknown) => void)[] = [];
  calls.invoke.mockImplementation(
    () => new Promise((resolve) => resolves.push(resolve)),
  );
  const a = new AbortController(),
    b = new AbortController();
  const first = prepareCompatibleAudio(source, a.signal),
    second = prepareCompatibleAudio(source, b.signal);
  await vi.waitFor(() => expect(calls.invoke).toHaveBeenCalledTimes(2));
  a.abort();
  b.abort();
  await expect(
    prepareCompatibleAudio(source, new AbortController().signal),
  ).rejects.toThrow(S.mediaBudgetReached);
  resolves[0](response());
  expect(await first).toBeNull();
  const free = messageMediaBudget.acquire(16 * 1024 * 1024);
  expect(free).not.toBeNull();
  held.push(free!);
  expect(messageMediaBudget.acquire(1)).toBeNull();
  resolves[1](response());
  expect(await second).toBeNull();
  expect(url).not.toHaveBeenCalled();
});
it.each([
  ["busy", S.audioCompatibilityBusy],
  ["limit", S.audioCompatibilityLimit],
  ["unsupportedPlatform", S.audioCompatibilityUnavailable],
  ["private error", S.audioCompatibilityFailed],
])("maps %s without leaking backend text", async (code, message) => {
  calls.invoke.mockRejectedValue(code);
  await expect(
    prepareCompatibleAudio(source, new AbortController().signal),
  ).rejects.toThrow(message);
});
