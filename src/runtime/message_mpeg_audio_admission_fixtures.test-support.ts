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
// No separate sfx license override was found in media/test/data/README.md or licenses/.

/** Complete original Chromium sfx.mp3 audio-frame segment. The12 unmodified
 * frames start at main_data_begin0; repeating this complete segment keeps bit
 * reservoir references within each segment. CoreAudio fully decoded both files
 * to exactly their declared sample counts. No header-only playback fixture.
 * Official blob d9eb2f3f1d87baa72aad7a4dd450c416f8ffb702:
 * https://raw.githubusercontent.com/chromium/chromium/main/media/test/data/sfx.mp3
 * Provenance: output/2026-10-17-media-search-next-stage/mpeg-audio/.
 */
const SEGMENT =
  "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";
export const MESSAGE_MPEG_AUDIO_TEST_DATA = {
  TINY: SEGMENT,
  SHORT_3: btoa(atob(SEGMENT).repeat(10)),
  LONG_601: btoa(atob(SEGMENT).repeat(1918)),
} as const;
export const MESSAGE_MPEG_AUDIO_TEST_PROVENANCE = {
  SHORT_3: {
    bytes: 16120,
    frames: 120,
    samples: 138240,
    sha256: "b62535444479a2b22b57da78a1e6498b4456f3cc27a5c0aa74a8f836d8e54b5e",
  },
  TINY: {
    bytes: 1612,
    frames: 12,
    samples: 13824,
    sha256: "ead5d01ed82c920006707188ba2dfa3755a13f26e042fadde631ce642a62d4e1",
  },
  LONG_601: {
    bytes: 3091816,
    frames: 23016,
    samples: 26514432,
    sha256: "ef915168e54b36932f964caf534cb7bfb0b44b845449dae91fe7d508e58aadf5",
  },
} as const;

/** Declaration-only variants; no encoded payload/CRC validity or playback claim. */
export function mpegAudioTestFrame({
  version = 3,
  rateIndex = 0,
  bitrateIndex = 1,
  padding = 0,
  crc = false,
  mode = 3,
}: {
  version?: 0 | 2 | 3;
  rateIndex?: number;
  bitrateIndex?: number;
  padding?: number;
  crc?: boolean;
  mode?: number;
} = {}): Buffer {
  const rate =
    [44100, 48000, 32000][rateIndex] /
    (version === 3 ? 1 : version === 2 ? 2 : 4);
  const bitrate = (
    version === 3
      ? [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320]
      : [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
  )[bitrateIndex];
  const length =
    Math.floor((bitrate * 144000) / (rate * (version === 3 ? 1 : 2))) + padding;
  const bytes = Buffer.alloc(length);
  bytes[0] = 255;
  bytes[1] = 0xe0 | (version << 3) | 2 | (crc ? 0 : 1);
  bytes[2] = (bitrateIndex << 4) | (rateIndex << 2) | (padding << 1);
  bytes[3] = mode << 6;
  return bytes;
}
export function mpegAudioTestFile(...frames: Buffer[]): string {
  return Buffer.concat(frames).toString("base64");
}
