// Copyright 2015 The Chromium Authors
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are
// met:
//
//    * Redistributions of source code must retain the above copyright
// notice, this list of conditions and the following disclaimer.
//    * Redistributions in binary form must reproduce the above
// copyright notice, this list of conditions and the following disclaimer
// in the documentation and/or other materials provided with the
// distribution.
//    * Neither the name of Google LLC nor the names of its
// contributors may be used to endorse or promote products derived from
// this software without specific prior written permission.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
// "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
// LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
// A PARTICULAR PURPOSE ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT
// OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
// SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
// LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
// DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
// THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
// OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
// License source: https://chromium.googlesource.com/chromium/src/+/refs/heads/main/LICENSE
// SPDX-License-Identifier: BSD-3-Clause
// Derived test audio source: Chromium media/test/data/sfx.mp3, official blob
// d9eb2f3f1d87baa72aad7a4dd450c416f8ffb702; provenance was pinned in
// output/2026-10-17-media-search-next-stage/mpeg-audio/. These M4A controls are
// local CoreAudio encodings of the already independently decoded test PCM.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Complete local CoreAudio m4af/AAC outputs, each fully decoded to PCM.
 * Node-only test storage; browser harnesses materialize the returned Base64 in
 * Node, never bundle fs/crypto. These files are exact encoder bytes, not remuxed
 * or header-only controls. Source PCM is controlled Chromium BSD sound-effect
 * data from the earlier MP3 tests; no user audio or remote data is used.
 * See output/2026-10-17-media-container-stage/mp4/control-reconciliation.json
 * and short-control-evidence.json. Same-vendor encode/decode is not complete
 * codec conformance or browser-playback proof. Declaration fixtures below are
 * separate and must never be passed to any audio decoder.
 */
function completeFile(name: string, bytes: number, sha256: string): string {
  const data = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  if (
    data.length !== bytes ||
    createHash("sha256").update(data).digest("hex") !== sha256
  )
    throw new Error("Complete MP4 test fixture identity changed");
  return data.toString("base64");
}

export const MESSAGE_MP4_AUDIO_TEST_PROVENANCE = {
  LONG_601: {
    bytes: 2_446_361,
    sha256: "41532e20c95c290c1f36a0ce9e3abed124063478a5548d16a9b0d20922f164ef",
    decodedSampleFrames: 19_239_497,
    decodedSampleRate: 32_000,
    decodedChannels: 1,
    decodedPcmSha256:
      "ec263199a983b8f6bd65f070d436b2aad514a656fb10eba4ca680de519bc9763",
    mediaTimescale: 32_000,
    mediaDurationTicks: 19_241_984,
  },
  SHORT_3: {
    bytes: 16_054,
    sha256: "1ad7165c788a38f59c5db86c984f57807810bbbf628af99571434e32dc46db0e",
    decodedSampleFrames: 100_310,
    decodedSampleRate: 32_000,
    decodedChannels: 1,
    decodedPcmSha256:
      "beb19eef76ba471ddad2f9f6137937a7cbe0c0c05246b4d0808634ef0529d738",
    mediaTimescale: 32_000,
    mediaDurationTicks: 103_424,
  },
} as const;

export const MESSAGE_MP4_AUDIO_TEST_DATA = {
  LONG_601: completeFile(
    "message-mp4-long-601.m4a",
    MESSAGE_MP4_AUDIO_TEST_PROVENANCE.LONG_601.bytes,
    MESSAGE_MP4_AUDIO_TEST_PROVENANCE.LONG_601.sha256,
  ),
  SHORT_3: completeFile(
    "message-mp4-short-3.m4a",
    MESSAGE_MP4_AUDIO_TEST_PROVENANCE.SHORT_3.bytes,
    MESSAGE_MP4_AUDIO_TEST_PROVENANCE.SHORT_3.sha256,
  ),
} as const;

/** Declaration-only variants. Their opaque mdat is not an AAC bitstream and
 * these builders are never evidence of codec validity or actual playback. */
export function mp4TestU32(value: number): Buffer {
  const result = Buffer.alloc(4);
  result.writeUInt32BE(value);
  return result;
}
function u64(value: bigint): Buffer {
  const result = Buffer.alloc(8);
  result.writeBigUInt64BE(value);
  return result;
}
export function mp4TestBox(
  kind: string,
  data: Buffer = Buffer.alloc(0),
  { extended = false, zero = false } = {},
): Buffer {
  return Buffer.concat([
    mp4TestU32(zero ? 0 : extended ? 1 : data.length + 8),
    Buffer.from(kind, "latin1"),
    ...(extended ? [u64(BigInt(data.length + 16))] : []),
    data,
  ]);
}
export interface Mp4AudioTestTrack {
  handler?: string;
  handlerVersion?: number;
  scale?: number;
  duration?: bigint;
  mdhdVersion?: number;
  mdhdFlags?: number;
  timeline?: readonly (readonly [number, number])[] | null;
  sttsVersion?: number;
  sttsFlags?: number;
  extraMedia?: Buffer[];
  extraTable?: Buffer[];
  extraTrack?: Buffer[];
  noHeader?: boolean;
  noHandler?: boolean;
  noInfo?: boolean;
  edit?: boolean;
}
export function mp4TestMdhd({
  scale = 1,
  duration = 600n,
  mdhdVersion = 0,
  mdhdFlags = 0,
}: Mp4AudioTestTrack = {}): Buffer {
  return mp4TestBox(
    "mdhd",
    Buffer.concat([
      mp4TestU32((mdhdVersion << 24) | mdhdFlags),
      Buffer.alloc(mdhdVersion === 1 ? 16 : 8),
      mp4TestU32(scale),
      mdhdVersion === 1 ? u64(duration) : mp4TestU32(Number(duration)),
      Buffer.alloc(4),
    ]),
  );
}
export function mp4TestStts(
  timeline: readonly (readonly [number, number])[],
  version = 0,
  flags = 0,
): Buffer {
  return mp4TestBox(
    "stts",
    Buffer.concat([
      mp4TestU32((version << 24) | flags),
      mp4TestU32(timeline.length),
      ...timeline.flatMap(([count, delta]) => [
        mp4TestU32(count),
        mp4TestU32(delta),
      ]),
    ]),
  );
}
export function mp4TestTrack(options: Mp4AudioTestTrack = {}): Buffer {
  const time =
    options.timeline === null
      ? []
      : [
          mp4TestStts(
            options.timeline ?? [[600, 1]],
            options.sttsVersion,
            options.sttsFlags,
          ),
        ];
  return mp4TestBox(
    "trak",
    Buffer.concat([
      ...(options.edit ? [mp4TestBox("edts")] : []),
      ...(options.extraTrack ?? []),
      mp4TestBox(
        "mdia",
        Buffer.concat([
          ...(options.noHeader ? [] : [mp4TestMdhd(options)]),
          ...(options.noHandler
            ? []
            : [
                mp4TestBox(
                  "hdlr",
                  Buffer.concat([
                    mp4TestU32((options.handlerVersion ?? 0) << 24),
                    Buffer.alloc(4),
                    Buffer.from(options.handler ?? "soun"),
                    Buffer.alloc(12),
                  ]),
                ),
              ]),
          ...(options.extraMedia ?? []),
          ...(options.noInfo
            ? []
            : [
                mp4TestBox(
                  "minf",
                  mp4TestBox(
                    "stbl",
                    Buffer.concat([...time, ...(options.extraTable ?? [])]),
                  ),
                ),
              ]),
        ]),
      ),
    ]),
  );
}
export function mp4AudioTestBytes({
  tracks = [mp4TestTrack()],
  brands = ["M4A ", "isom"],
  fragment = false,
  extraTop = [],
  extraMovie = [],
  noMovie = false,
  noMedia = false,
}: {
  tracks?: Buffer[];
  brands?: string[];
  fragment?: boolean;
  extraTop?: Buffer[];
  extraMovie?: Buffer[];
  noMovie?: boolean;
  noMedia?: boolean;
} = {}): Buffer {
  return Buffer.concat([
    mp4TestBox(
      "ftyp",
      Buffer.concat([
        Buffer.from(brands[0] ?? "zzzz"),
        Buffer.alloc(4),
        ...brands.slice(1).map((brand) => Buffer.from(brand)),
      ]),
    ),
    ...(noMovie
      ? []
      : [
          mp4TestBox(
            "moov",
            Buffer.concat([
              ...tracks,
              ...extraMovie,
              ...(fragment ? [mp4TestBox("mvex")] : []),
            ]),
          ),
        ]),
    ...extraTop,
    ...(fragment ? [mp4TestBox("moof")] : []),
    ...(noMedia ? [] : [mp4TestBox("mdat", Buffer.from([0]))]),
  ]);
}
export function mp4AudioTestFile(
  options: Parameters<typeof mp4AudioTestBytes>[0] = {},
): string {
  return mp4AudioTestBytes(options).toString("base64");
}
