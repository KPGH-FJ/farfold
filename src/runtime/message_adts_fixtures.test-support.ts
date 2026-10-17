/** Complete CoreAudio AAC-LC encoder outputs, independently decoded by
 * afconvert to PCM. Test-only RLE reconstructs the exact original files; this
 * is not a synthetic header claimed to be playable. Encoder/decoder share
 * CoreAudio, so this is not an independent-vendor codec conformance test.
 * See output/2026-10-17-adts-admission-stage/control-evidence.json.
 */
const REAL_FRAME = "\xff\xf9\x6c\x60\x01\x60\x00\x00\xd0\x00\x07";
export const MESSAGE_ADTS_TEST_DATA = {
  TINY: btoa(REAL_FRAME.repeat(3)),
  LONG_601: btoa(REAL_FRAME.repeat(4698)),
} as const;

export const MESSAGE_ADTS_TEST_PROVENANCE = {
  TINY: {
    bytes: 33,
    frames: 3,
    decodedSamples: 3072,
    sha256: "a5670c6a6c74a910f54b7665af4a907fa3285ca0ce7911c5a2f34c7b656668f0",
  },
  LONG_601: {
    bytes: 51_678,
    frames: 4698,
    decodedSamples: 4_810_752,
    sha256: "a69cad64f1d0b57ec8dd9cc43478788307c290d958527972964297e2eb559413",
  },
} as const;

/** Declaration-only variants. Payloads/CRCs are opaque placeholders, so these
 * builders are never codec/playback fixtures or proof of valid AAC payloads.
 */
export function adtsTestFrame({
  profile = 1,
  rateIndex = 11,
  blocks = 1,
  crc = false,
  channelConfig = 1,
  mpeg2 = true,
  length = crc ? 11 : 9,
  declaredLength = length,
}: {
  profile?: number;
  rateIndex?: number;
  blocks?: number;
  crc?: boolean;
  channelConfig?: number;
  mpeg2?: boolean;
  length?: number;
  declaredLength?: number;
} = {}): Buffer {
  const bytes = Buffer.alloc(length);
  bytes[0] = 0xff;
  bytes[1] = 0xf0 | (mpeg2 ? 8 : 0) | (crc ? 0 : 1);
  bytes[2] = (profile << 6) | (rateIndex << 2) | (channelConfig >>> 2);
  bytes[3] = ((channelConfig & 3) << 6) | (declaredLength >>> 11);
  bytes[4] = (declaredLength >>> 3) & 255;
  bytes[5] = ((declaredLength & 7) << 5) | 31;
  bytes[6] = 0xfc | (blocks - 1);
  return bytes;
}

export function adtsTestFile(...frames: Buffer[]): string {
  return Buffer.concat(frames).toString("base64");
}
