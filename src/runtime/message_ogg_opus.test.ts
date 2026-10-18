import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { messageOggAudioAdmission as admit } from "./message_ogg_audio_admission";
import {
  attachmentMediaAdmission,
  normalizeMessageAttachment,
} from "./message_attachments";
import {
  oggTestPage as page,
  oggTestPackets as packets,
} from "./message_ogg_audio_fixtures.test-support";

function complete(name: string, pin: string) {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(pin);
  return bytes.toString("base64");
}
// Unmodified official libopusenc0.2.1/libopus1.5.2 output from generated mono
// 16kHz tones. A separate opusfile0.12 consumer read all 96000/29280000 finite,
// nonzero 48kHz frames. Same-vendor roundtrips, not general codec conformance.
const short = complete(
  "message-opus-short-2.opus",
  "a95623d05ef699f663711731f21c72bb2dea1f9e4fa2445b96ac8efb640530d4",
);
const long = complete(
  "message-opus-long-610.opus",
  "2542a465a600eb9b4120be45970cb6a0e53c3a1535b152d09b09b20a706b4448",
);
const limit = 28_800_000n;
const encode = (pages: Buffer[]) => Buffer.concat(pages).toString("base64");
// The declarations below exercise metadata policy; they are not codec files.
function head({ preSkip = 312, inputRate = 16000, channels = 1 } = {}) {
  const bytes = Buffer.alloc(19);
  bytes.write("OpusHead");
  bytes[8] = 1;
  bytes[9] = channels;
  bytes.writeUInt16LE(preSkip, 10);
  bytes.writeUInt32LE(inputRate, 12);
  return bytes;
}
const tags = Buffer.concat([Buffer.from("OpusTags"), Buffer.alloc(8)]);
function headers(id = head(), serial = 1) {
  return [
    page({ serial, flags: 2, granule: 0n, ...packets([id]) }),
    page({ serial, sequence: 1, granule: 0n, ...packets([tags]) }),
  ];
}
function audio(sequence: number, granule: bigint, flags = 0, serial = 1) {
  return page({
    sequence,
    granule,
    flags,
    serial,
    ...packets([Buffer.from([1])]),
  });
}
function interval({
  id = head(),
  origin = 48000n,
  delta = limit + 313n,
  serial = 1,
  terminalFlags = 4,
} = {}) {
  return [
    ...headers(id, serial),
    audio(2, origin, 0, serial),
    audio(3, origin + delta, terminalFlags, serial),
  ];
}

it("keeps complete 2s Opus partial and rejects the 610s source by a 609s lower bound", () => {
  expect(admit(short)).toBe("notCovered");
  expect(admit(long)).toBe("audioTooLong");
});
it.each([0, 8000, 16000, 44100])(
  "uses the fixed 48k granule clock with informational input rate %s",
  (inputRate) => {
    expect(admit(encode(interval({ id: head({ inputRate }) })))).toBe(
      "audioTooLong",
    );
    expect(
      admit(encode(interval({ id: head({ inputRate }), delta: 16_001n }))),
    ).toBe("notCovered");
  },
);
it.each([0, 312, 65535])(
  "subtracts all preSkip %s before the exact threshold",
  (preSkip) => {
    for (const [extra, expected] of [
      [0n, "notCovered"],
      [1n, "audioTooLong"],
    ] as const)
      expect(
        admit(
          encode(
            interval({
              id: head({ preSkip }),
              delta: limit + BigInt(preSkip) + extra,
            }),
          ),
        ),
      ).toBe(expected);
  },
);
it("does not count an anchor still inside a long discarded prefix", () => {
  // RFC7845 preSkip may span many packets. Raw endpoint difference exceeds
  // 600s here, but whole playable length at origin zero is only 598.654708s.
  expect(
    admit(
      encode(
        interval({
          id: head({ preSkip: 65535 }),
          origin: 960n,
          delta: limit + 1n,
        }),
      ),
    ),
  ).toBe("notCovered");
});
it("retains conservative preSkip subtraction with a large positive origin", () => {
  expect(
    admit(
      encode(
        interval({
          id: head({ preSkip: 65535 }),
          origin: 1n << 60n,
          delta: limit + 1n,
        }),
      ),
    ),
  ).toBe("notCovered");
  expect(admit(encode(interval({ origin: 1n << 60n })))).toBe("audioTooLong");
});
it("never multiplies the interval by stereo channels", () => {
  expect(
    admit(encode(interval({ id: head({ channels: 2 }), delta: limit }))),
  ).toBe("notCovered");
});
it.each([0, 1, 3, 254, 255])(
  "does not apply the Vorbis low-bit test to Opus TOC %s",
  (toc) => {
    expect(
      admit(
        encode([
          ...headers(),
          page({
            sequence: 2,
            granule: 48000n,
            ...packets([Buffer.from([toc])]),
          }),
          audio(3, 48000n + limit + 313n, 4),
        ]),
      ),
    ).toBe("audioTooLong");
  },
);
it("does not use empty audio packets as completed endpoints", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({ sequence: 2, granule: 48000n, ...packets([Buffer.alloc(0)]) }),
        audio(3, 48000n + limit + 313n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it.each([
  head().subarray(0, 18),
  Buffer.concat([head(), Buffer.from([0])]),
  Buffer.from([...head().subarray(0, 8), 2, ...head().subarray(9)]),
  Buffer.from([...head().subarray(0, 18), 1]),
  head({ channels: 0 }),
  head({ channels: 3 }),
])("leaves unsupported Opus header layouts partial", (id) => {
  expect(admit(encode(interval({ id })))).toBe("notCovered");
});
it("requires an identification packet alone on BOS and the ordered Tags header", () => {
  for (const badHeaders of [
    [page({ flags: 2, ...packets([head(), tags]) })],
    [headers()[0]],
    [headers()[0], page({ sequence: 1, ...packets([head()]) })],
    [
      headers()[0],
      page({ sequence: 1, ...packets([Buffer.from("OpusTags")]) }),
    ],
  ])
    expect(
      admit(
        encode([
          ...badHeaders,
          audio(2, 48000n),
          audio(3, 48000n + limit + 313n, 4),
        ]),
      ),
    ).toBe("notCovered");
});
it("allows Tags continuation but requires audio to begin on a later page", () => {
  const comment = Buffer.concat([tags, Buffer.alloc(284)]);
  const start = [
    headers()[0],
    page({ sequence: 1, laces: [255], body: comment.subarray(0, 255) }),
  ];
  expect(
    admit(
      encode([
        ...start,
        page({
          sequence: 2,
          flags: 1,
          granule: 0n,
          ...packets([comment.subarray(255)]),
        }),
        audio(3, 48000n),
        audio(4, 48000n + limit + 313n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
  expect(
    admit(
      encode([
        ...start,
        page({
          sequence: 2,
          flags: 1,
          granule: 48000n,
          ...packets([comment.subarray(255), Buffer.from([1])]),
        }),
        audio(3, 48000n + limit + 313n, 4),
      ]),
    ),
  ).toBe("notCovered");
});
it("uses a terminating zero lace and never a continuation-only page as an endpoint", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({
          sequence: 2,
          granule: 48000n + limit + 313n,
          laces: [255],
          body: Buffer.alloc(255, 1),
        }),
        page({ sequence: 3, flags: 1, granule: 48000n, laces: [0] }),
        audio(4, 48000n + limit + 313n, 4),
      ]),
    ),
  ).toBe("audioTooLong");
});
it("does not use headers, empty pages or a lone EOS audio page as anchors", () => {
  expect(
    admit(
      encode([
        ...headers(),
        page({ sequence: 2, granule: 48000n }),
        audio(3, 99_000_000n, 4),
      ]),
    ),
  ).toBe("notCovered");
  expect(admit(encode([...headers(), audio(2, 99_000_000n, 4)]))).toBe(
    "notCovered",
  );
});
it.each([-1n, -2n])(
  "does not reinterpret signed granule %s as an endpoint",
  (origin) => {
    expect(admit(encode(interval({ origin })))).toBe("notCovered");
  },
);
it("allows a non-EOS terminal but revokes an interval after a late timing or sequence contradiction", () => {
  const pages = interval({ terminalFlags: 0 });
  expect(admit(encode(pages))).toBe("audioTooLong");
  expect(admit(encode([...pages, audio(4, 1n, 4)]))).toBe("notCovered");
  expect(admit(encode([...pages, audio(5, 99_000_000n, 4)]))).toBe(
    "notCovered",
  );
  expect(
    admit(
      encode([
        ...pages,
        page({ sequence: 4, laces: [255], body: Buffer.alloc(255) }),
      ]),
    ),
  ).toBe("notCovered");
});
it("keeps parallel and repeated serial epochs separate, while preserving an independent known interval", () => {
  const a = interval({ delta: limit / 2n });
  const b = interval({ serial: 2, delta: limit / 2n });
  expect(admit(encode([...a, ...b]))).toBe("notCovered");
  expect(admit(encode([...a, ...a]))).toBe("notCovered");
  expect(
    admit(encode([...interval(), ...headers(head(), 2), audio(2, -1n, 4, 2)])),
  ).toBe("audioTooLong");
});

const audioMimes = [
  "audio/mpeg",
  "audio/mp3",
  "audio/mp4",
  "audio/ogg",
  "audio/wav",
  "audio/wave",
  "audio/x-wav",
  "audio/webm",
  "audio/flac",
  "audio/aac",
];
it.each(audioMimes)(
  "preserves short and rejects long Opus under existing label %s",
  (mimeType) => {
    for (const [data, isLong] of [
      [short, false],
      [long, true],
    ] as const) {
      const input = {
        kind: "audio" as const,
        name: "Complete Opus",
        mimeType,
        data,
      };
      const original = JSON.stringify(input);
      expect(attachmentMediaAdmission(input)).toEqual(
        isLong
          ? { status: "rejected", reason: "audioTooLong" }
          : {
              status: "available",
              media: { kind: "audio", src: `data:${mimeType};base64,${data}` },
            },
      );
      expect(JSON.stringify(input)).toBe(original);
    }
  },
);
it("applies the same guard to embedded bytes without reading a URI or adding a MIME label", () => {
  const content = {
    type: "resource",
    resource: {
      uri: "file:///controlled/opus",
      mimeType: "audio/ogg",
      blob: long,
    },
  };
  const original = JSON.stringify(content);
  const attachment = normalizeMessageAttachment(content)!;
  expect(attachment.data).toBe(long);
  expect(attachmentMediaAdmission(attachment)).toEqual({
    status: "rejected",
    reason: "audioTooLong",
  });
  expect(JSON.stringify(content)).toBe(original);
  expect(
    attachmentMediaAdmission({
      name: "Unsupported label",
      mimeType: "audio/opus",
      data: short,
    }),
  ).toEqual({ status: "unavailable" });
  expect(
    attachmentMediaAdmission({
      name: "URI only",
      mimeType: "audio/ogg",
      uri: "https://example.invalid/never-read.opus",
    }),
  ).toEqual({ status: "unavailable" });
});
