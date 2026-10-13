import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  decodeDraftAudio,
  encodeDraftAudio,
  MAX_AUDIO_EXPANDED_BYTES,
  MAX_AUDIO_REFERENCES,
} from "./draft_audio_encoding";
import { audioAttachment } from "./audio_input.test-support";
const base = () => ({
  version: 1,
  composers: {
    new: {
      text: "keep",
      attachments: [audioAttachment()],
      queueEdit: {
        index: 0,
        original: [{ type: "audio", ...audioAttachment() }],
      },
    },
  },
  choice: { agentId: "chosen", cwd: "/chosen", service: null, config: {} },
  feedback: {},
  queues: {
    one: {
      blocks: [[{ type: "audio", ...audioAttachment() }]],
      uncertainIndex: null,
    },
  },
});
const encoded = () => JSON.parse(JSON.stringify(encodeDraftAudio(base())));
beforeEach(() => {
  h.invoke.mockReset();
});
it("deduplicates only complete equal audio strings within one snapshot, keeps all source metadata, and expands isolated objects", () => {
  const value = base(),
    before = structuredClone(value),
    compressed = encoded();
  expect(compressed.audioEncoding.version).toBe(1);
  expect(compressed.audioEncoding.values).toEqual([audioAttachment().data]);
  expect(compressed.composers.new.attachments[0].data).toEqual({ audioRef: 0 });
  const decoded = decodeDraftAudio(compressed) as ReturnType<typeof base>;
  expect(decoded).toEqual(value);
  expect(value).toEqual(before);
  expect(decoded.composers.new.attachments[0].localAudio).not.toBe(
    decoded.queues.one.blocks[0][0].localAudio,
  );
  decoded.composers.new.attachments[0].localAudio!.file.name = "changed";
  expect(decoded.queues.one.blocks[0][0].localAudio!.file.name).toBe(
    "sample.wav",
  );
  expect(compressed.composers.new.attachments[0].localAudio.file.name).toBe(
    "sample.wav",
  );
});
it("same source hash never aliases different complete data", () => {
  const value = base();
  value.queues.one.blocks[0][0].data += "DIFFERENT";
  const compressed = encodeDraftAudio(value) as {
    audioEncoding: { values: string[] };
  };
  expect(compressed.audioEncoding.values).toHaveLength(2);
  expect(decodeDraftAudio(compressed)).toEqual(value);
});
it("leaves old v1 and ordinary non-audio strings untouched", () => {
  const old = {
    version: 1,
    composers: {
      new: {
        text: "audioRef:0",
        attachments: [
          audioAttachment(),
          { id: "image", kind: "image", data: audioAttachment().data },
        ],
      },
    },
    queues: {},
  };
  expect(encodeDraftAudio(old)).toBe(old);
  expect(decodeDraftAudio(old)).toBe(old);
  const value = {
    ...base(),
    feedback: { ordinary: { data: { audioRef: 0 } } },
  };
  expect(
    (decodeDraftAudio(encodeDraftAudio(value)) as typeof value).feedback,
  ).toEqual(value.feedback);
});
it.each([
  (v: ReturnType<typeof encoded>) => {
    v.audioEncoding.version = 2;
  },
  (v: ReturnType<typeof encoded>) => {
    delete v.audioEncoding.values;
  },
  (v: ReturnType<typeof encoded>) => {
    v.audioEncoding.values = [{ audioRef: 0 }];
  },
  (v: ReturnType<typeof encoded>) => {
    v.audioEncoding.values.push("unused");
  },
  (v: ReturnType<typeof encoded>) => {
    v.audioEncoding.values.push(v.audioEncoding.values[0]);
  },
  (v: ReturnType<typeof encoded>) => {
    v.audioEncoding.path = "/private/arbitrary";
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = { audioRef: -1 };
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = { audioRef: 0.1 };
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = { audioRef: 1 };
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = { audioRef: "0" };
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = {
      audioRef: 0,
      path: "/private/arbitrary",
    };
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = {};
  },
  (v: ReturnType<typeof encoded>) => {
    v.composers.new.attachments[0].data = "mixed inline";
  },
])(
  "rejects malformed, unknown or dangling encoding as a whole without any settings write",
  async (mutate) => {
    const value = encoded();
    mutate(value);
    h.invoke.mockResolvedValue(value);
    vi.resetModules();
    const d = await import("./drafts");
    await expect(d.draftPersistence.load()).rejects.toThrow();
    expect(d.composerDrafts.hasContent("new")).toBe(false);
    expect(h.invoke.mock.calls.map(([cmd]) => cmd)).toEqual(["settings_get"]);
  },
);
it("rejects cyclic snapshot or cross-snapshot references", () => {
  const value = encoded();
  value.audioEncoding.values[0] = value;
  expect(() => decodeDraftAudio(value)).toThrow();
  const next = encoded();
  next.audioEncoding.values = [];
  expect(() => decodeDraftAudio(next)).toThrow();
});
it("limits reference count before expansion", () => {
  const value = encoded();
  value.composers.new.attachments = Array.from(
    { length: MAX_AUDIO_REFERENCES + 1 },
    () => ({ ...value.composers.new.attachments[0] }),
  );
  expect(() => decodeDraftAudio(value)).toThrow();
});
it("counts UTF-8 and JSON escaping in the 96MiB expansion boundary", () => {
  const value = encoded(),
    text = '汉\\"'.repeat(1024 * 1024);
  value.audioEncoding.values = [text];
  value.composers.new.attachments = Array.from({ length: 16 }, () => ({
    ...value.composers.new.attachments[0],
  }));
  expect(new TextEncoder().encode(JSON.stringify(value)).length).toBeLessThan(
    32 * 1024 * 1024,
  );
  expect(text.length * 18).toBeLessThan(MAX_AUDIO_EXPANDED_BYTES);
  expect(() => decodeDraftAudio(value)).toThrow();
});
it("bounds amplification before stringify can expand a small encoded value into gigabytes", () => {
  const value = base();
  const text = "a".repeat(22 * 1024 * 1024);
  value.composers.new.attachments = Array.from({ length: 100 }, () => ({
    ...audioAttachment(),
    data: text,
  }));
  expect(() => encodeDraftAudio(value)).toThrow();
});
it("encoded 32MiB limit remains separate from bounded expanded memory", () => {
  const value = encoded();
  value.audioEncoding.values[0] = "a".repeat(32 * 1024 * 1024);
  expect(() => decodeDraftAudio(value)).toThrow();
});
it("uses final exact expansion bytes independently of large and empty historical string order", () => {
  const long = "A".repeat(2097088);
  for (const shortFirst of [false, true]) {
    const refs = [
      ...Array.from({ length: 48 }, () => ({
        kind: "audio",
        data: { audioRef: 0 },
      })),
      { kind: "audio", data: { audioRef: 1 } },
    ];
    if (shortFirst) refs.reverse();
    const body = {
      version: 1,
      composers: { new: { text: "", attachments: refs } },
      queues: {},
    };
    const referenceBytes = new TextEncoder().encode(
      JSON.stringify(body),
    ).length;
    const delta =
      48 * (new TextEncoder().encode(JSON.stringify(long)).length - 14) +
      (2 - 14);
    body.composers.new.text = "p".repeat(
      MAX_AUDIO_EXPANDED_BYTES - 1 - referenceBytes - delta,
    );
    const value = {
      ...body,
      audioEncoding: { version: 1, values: [long, ""] },
    };
    expect(() => decodeDraftAudio(value)).not.toThrow();
    body.composers.new.text += "xx";
    expect(() =>
      decodeDraftAudio({ ...body, audioEncoding: value.audioEncoding }),
    ).toThrow();
  }
});
