import { MESSAGE_ADTS_TEST_DATA as ADTS } from "./message_adts_fixtures.test-support";
import { MESSAGE_MPEG_AUDIO_TEST_DATA as MPEG } from "./message_mpeg_audio_admission_fixtures.test-support";

const synchsafe = (value: number) =>
  Buffer.from([21, 14, 7, 0].map((shift) => (value >>> shift) & 127));

/** Outer-layout variants only unless named below with complete decoded audio.
 * Unknown versions/flags, zero bodies, padding and damaged extents are not
 * presented as valid metadata, codec fixtures or successful playback. */
export function id3PrefixTestBytes({
  version = 3,
  revision = 0,
  flags = 0,
  footer = version === 4 && !!(flags & 16),
  body,
  declaredSize,
}: {
  version?: number;
  revision?: number;
  flags?: number;
  footer?: boolean;
  body?: Buffer;
  declaredSize?: number;
} = {}): Buffer {
  if (!body) {
    const text = Buffer.from("\0Farfold controlled ID3", "binary");
    if (version === 2) {
      const length = Buffer.alloc(3);
      length.writeUIntBE(text.length, 0, 3);
      body = Buffer.concat([Buffer.from("TT2"), length, text]);
    } else {
      const length = Buffer.alloc(4);
      length.writeUInt32BE(text.length);
      body = Buffer.concat([
        Buffer.from("TIT2"),
        version === 4 ? synchsafe(text.length) : length,
        Buffer.alloc(2),
        text,
      ]);
    }
  }
  const fields = Buffer.concat([
    Buffer.from([version, revision, flags]),
    synchsafe(declaredSize ?? body.length),
  ]);
  return Buffer.concat([
    Buffer.from("ID3"),
    fields,
    body,
    ...(footer ? [Buffer.from("3DI"), fields] : []),
  ]);
}

export function id3PrefixTestFile(
  audio: string,
  options: Parameters<typeof id3PrefixTestBytes>[0] = {},
): string {
  return Buffer.concat([
    id3PrefixTestBytes(options),
    Buffer.from(audio, "base64"),
  ]).toString("base64");
}

/** Complete prior encoder bytes + real title frame. MPEG provenance and BSD
 * license remain in its imported fixture module; no new audio is invented.
 * v2.2/2.3/v2.4footer MP3 controls were fully independently decoded to the
 * identical bare PCM samples/hash, not merely accepted by this header parser.
 * v2.3 ADTS controls also fully decode to the original bare PCM; the33-byte
 * input's prior WebKit failure remains. ADTS_SHORT_65 uses the earlier exact
 * complete512-frame control, not a retry of that old browser failure.
 * Evidence: output/2026-10-17-tagged-audio-stage/id3/complete-controls.json,
 * complete-adts-controls.json and complete-adts-short65-control.json.
 */
export const MESSAGE_AUDIO_PREFIX_TEST_DATA = {
  MPEG_LONG_601: id3PrefixTestFile(MPEG.LONG_601),
  MPEG_SHORT_3: id3PrefixTestFile(MPEG.SHORT_3),
  MPEG_V22_SHORT_3: id3PrefixTestFile(MPEG.SHORT_3, { version: 2 }),
  MPEG_V24_FOOTER_SHORT_3: id3PrefixTestFile(MPEG.SHORT_3, {
    version: 4,
    flags: 16,
  }),
  ADTS_TINY: id3PrefixTestFile(ADTS.TINY),
  ADTS_LONG_601: id3PrefixTestFile(ADTS.LONG_601),
  ADTS_SHORT_65: id3PrefixTestFile(
    btoa(atob(ADTS.TINY).slice(0, 11).repeat(512)),
  ),
} as const;
