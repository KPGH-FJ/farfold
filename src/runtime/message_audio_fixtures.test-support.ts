// CPython stdlib wave generated/read-back: mono PCM8, 8000Hz, 80 silent
// frames, 124 complete bytes. SHA256:
// 48f9b734687b6c7b57cbcba2b5e799706c85c770d181de055b728abb2c9ca7e6
export const MESSAGE_AUDIO_WAV_TEST_DATA =
  "UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==";

export interface WaveTestChunk {
  kind: string;
  data: Buffer;
}

export function waveTestChunk({ kind, data }: WaveTestChunk): Buffer {
  const out = Buffer.alloc(8 + data.length + (data.length % 2));
  out.write(kind, 0, 4, "ascii");
  out.writeUInt32LE(data.length, 4);
  data.copy(out, 8);
  return out;
}

export function waveTestRiff(chunks: readonly WaveTestChunk[]): Buffer {
  const payload = Buffer.concat([
    Buffer.from("WAVE"),
    ...chunks.map(waveTestChunk),
  ]);
  const header = Buffer.alloc(8);
  header.write("RIFF");
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

/** Declaration/structure variants only; changed headers are not codec proof. */
export function wavTestFile({
  format = 1,
  channels = 1,
  sampleRate = 8000,
  bits = 8,
  frames = 80,
  extensible = false,
  validBits = bits,
  before = [],
  after = [],
}: {
  format?: number;
  channels?: number;
  sampleRate?: number;
  bits?: number;
  frames?: number;
  extensible?: boolean;
  validBits?: number;
  before?: readonly WaveTestChunk[];
  after?: readonly WaveTestChunk[];
} = {}): Buffer {
  const align = channels * Math.ceil(bits / 8);
  const fmt = Buffer.alloc(extensible ? 40 : format === 1 ? 16 : 18);
  fmt.writeUInt16LE(extensible ? 0xfffe : format);
  fmt.writeUInt16LE(channels, 2);
  fmt.writeUInt32LE(sampleRate, 4);
  fmt.writeUInt32LE(sampleRate * align, 8);
  fmt.writeUInt16LE(align, 12);
  fmt.writeUInt16LE(bits, 14);
  if (extensible) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(validBits, 18);
    Buffer.from([
      format,
      0,
      0,
      0,
      0,
      0,
      0x10,
      0,
      0x80,
      0,
      0,
      0xaa,
      0,
      0x38,
      0x9b,
      0x71,
    ]).copy(fmt, 24);
  }
  const data = Buffer.alloc(frames * align, bits === 8 ? 128 : 0);
  const fact = Buffer.alloc(4);
  fact.writeUInt32LE(frames);
  return waveTestRiff([
    { kind: "fmt ", data: fmt },
    ...(format === 1 ? [] : [{ kind: "fact", data: fact }]),
    ...before,
    { kind: "data", data },
    ...after,
  ]);
}
