import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

function complete(name: string, expected: string): string {
  const bytes = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  if (createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("Complete generated Vorbis fixture identity changed");
  return bytes.toString("base64");
}

// Locally generated mono 8kHz tones through official libogg1.3.5/libvorbis1.3.7
// public APIs. Complete ov_read_float roundtrips retained 16000/4880000 finite,
// nonzero PCM frames. These exact sources are not page-header mutations.
export const MESSAGE_OGG_TEST_DATA = {
  SHORT_2: complete(
    "message-vorbis-short-2.ogg",
    "985e6608b694a89391f55a0b85766f114488354c5fd2317b42197ba00a94a53e",
  ),
  LONG_610: complete(
    "message-vorbis-long-610.ogg",
    "0ab5c53906da7a9e80f07407fbb99030026409e5a2553330bbba8799d6392eb9",
  ),
};

export function oggTestPage({
  serial = 1,
  sequence = 0,
  flags = 0,
  granule = -1n,
  laces = [] as number[],
  body = Buffer.alloc(0),
  version = 0,
}: {
  serial?: number;
  sequence?: number;
  flags?: number;
  granule?: bigint;
  laces?: number[];
  body?: Buffer;
  version?: number;
} = {}): Buffer {
  const header = Buffer.alloc(27);
  header.write("OggS");
  header[4] = version;
  header[5] = flags;
  header.writeBigUInt64LE(BigInt.asUintN(64, granule), 6);
  header.writeUInt32LE(serial, 14);
  header.writeUInt32LE(sequence, 18);
  header[26] = laces.length;
  // Artificial declarations below do not set CRC or encode valid Vorbis audio.
  return Buffer.concat([header, Buffer.from(laces), body]);
}

export function oggTestPackets(packets: Buffer[]): {
  laces: number[];
  body: Buffer;
} {
  return {
    laces: packets.flatMap((packet) => [
      ...Array.from({ length: Math.floor(packet.length / 255) }, () => 255),
      packet.length % 255,
    ]),
    body: Buffer.concat(packets),
  };
}

export function oggTestIdentification(rate = 8000, channels = 1): Buffer {
  const packet = Buffer.alloc(30);
  packet[0] = 1;
  packet.write("vorbis", 1);
  packet[11] = channels;
  packet.writeUInt32LE(rate, 12);
  packet[28] = 0xb8;
  packet[29] = 1;
  return packet;
}

export function oggTestHeaders(serial = 1, rate = 8000): Buffer[] {
  return [
    oggTestPage({
      serial,
      flags: 2,
      granule: 0n,
      ...oggTestPackets([oggTestIdentification(rate)]),
    }),
    oggTestPage({
      serial,
      sequence: 1,
      granule: 0n,
      ...oggTestPackets([
        Buffer.concat([Buffer.from("\x03vorbis"), Buffer.alloc(9)]),
        Buffer.from("\x05vorbis\x01"),
      ]),
    }),
  ];
}
