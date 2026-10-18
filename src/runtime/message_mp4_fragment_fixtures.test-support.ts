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
// Derived from the same Chromium BSD controlled AAC fixtures as
// message_mp4_audio_fixtures.test-support.ts, locally remuxed by the official
// AVFoundation AppleHLS compressed passthrough interface without header edits.
// Complete short/long controls were fully decoded by CoreAudio. Remux trimming
// differs from the original; these are not exact elapsed-playback guarantees.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function complete(name: string, bytes: number, sha: string): string {
  const data = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  if (
    data.length !== bytes ||
    createHash("sha256").update(data).digest("hex") !== sha
  )
    throw new Error("Complete fragmented MP4 fixture identity changed");
  return data.toString("base64");
}
export const FMP4_CONTROLS = {
  SHORT_3: complete(
    "message-fmp4-short-3.mp4",
    13425,
    "4de3362be918c4863e3f99aadee9fa353dea0fbb7286c8d3aba1e9d2dbff378b",
  ),
  LONG_601: complete(
    "message-fmp4-long-601.mp4",
    2505856,
    "1e5985d0c3c8d45e123ca804da4ea8a0c90f059eee624ec4147398fed0c4bd2c",
  ),
};
