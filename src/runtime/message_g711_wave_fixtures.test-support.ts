import { createHash } from "node:crypto";

// Owned all256-value G.711 controls. Both tags at2/600/601seconds were read
// completely by CoreAudio and matched independent CPython audioop PCM SHA/MD5.
// Exact native receipts remain in output/2026-10-20-p13-g711-wave-budget/.
// These are not audible/WebKit/message-returned or decoder-memory proof.
export const G711_WAVE_PROVENANCE = [
  {
    case: "pcma_2s",
    seconds: 2,
    bytes: 16058,
    sha256: "270ef605778bee26876094fe016a9c192799efd16f058de52d6452b1bdb97cfe",
    formatTag: 6,
    frames: 16000,
    expectedPcmSha256:
      "f2276c369defb1b65f642bbdd4debab6ce21a5a2f4c6d445a4faac7d06b31b40",
    expectedPcmMd5: "f68163d8c444924921e2fee23aada191",
  },
  {
    case: "pcma_600s",
    seconds: 600,
    bytes: 4800058,
    sha256: "618917d2ef3560036046795601e999233db371f91026db57025892b3d14b2f04",
    formatTag: 6,
    frames: 4800000,
    expectedPcmSha256:
      "d2d8afb187378a6d1cdad5e792e91e7e29a1d75735866ecc1f4eca7be83d9219",
    expectedPcmMd5: "1c88afa4e176932cf1abd24e6bf4d187",
  },
  {
    case: "pcma_601s",
    seconds: 601,
    bytes: 4808058,
    sha256: "8e9a7927d38976ac6ee1b784e25f0e79df7ce8662140ab87cfbb3db5e7f78d4a",
    formatTag: 6,
    frames: 4808000,
    expectedPcmSha256:
      "2e3432b4ec99bc09c8a5d2646c50ee4a967362f6862ce40d09cd0921b667237f",
    expectedPcmMd5: "3851afe37c804408d710323ccdd4f857",
  },
  {
    case: "pcmu_2s",
    seconds: 2,
    bytes: 16058,
    sha256: "0dbdcf101b90562cc160a30905850816fc9b8b36590a046bc6a109a9c6b46df7",
    formatTag: 7,
    frames: 16000,
    expectedPcmSha256:
      "7eee921365cdbdd96da2009e73c6adafb78066ac560408f1d1f6320d606ffc44",
    expectedPcmMd5: "250fd0bf43dba2a903581883e7a7e1f1",
  },
  {
    case: "pcmu_600s",
    seconds: 600,
    bytes: 4800058,
    sha256: "71292f0ff8355101746f0a72091f6669c66a20e68d89a96e312a3751f3e5259b",
    formatTag: 7,
    frames: 4800000,
    expectedPcmSha256:
      "dec61547c55d0187ad309c4909d68bd210765376a2dab8b9c9dac7b4d548102e",
    expectedPcmMd5: "be73d4260f9d2de93569b381288f8ba8",
  },
  {
    case: "pcmu_601s",
    seconds: 601,
    bytes: 4808058,
    sha256: "9150ad71d6c765a5e0baaf8bc2b0aacce922be6ec8b0b6ae2317cf7863b71e79",
    formatTag: 7,
    frames: 4808000,
    expectedPcmSha256:
      "9a6dc3d8b35bed3ac91a87126a87aed81e98d2710ef271f4d6c235f90620721d",
    expectedPcmMd5: "4a1db961069e5a6f0b59dfd94ee3d19c",
  },
] as const;

export function g711WaveBytes(
  tag: 6 | 7,
  frames: number,
  channels = 1,
): Buffer {
  const dataBytes = frames * channels;
  const out = Buffer.alloc(58 + dataBytes + (dataBytes % 2));
  out.write("RIFF");
  out.writeUInt32LE(out.length - 8, 4);
  out.write("WAVE", 8);
  out.write("fmt ", 12);
  out.writeUInt32LE(18, 16);
  out.writeUInt16LE(tag, 20);
  out.writeUInt16LE(channels, 22);
  out.writeUInt32LE(8000, 24);
  out.writeUInt32LE(8000 * channels, 28);
  out.writeUInt16LE(channels, 32);
  out.writeUInt16LE(8, 34);
  out.writeUInt16LE(0, 36);
  out.write("fact", 38);
  out.writeUInt32LE(4, 42);
  out.writeUInt32LE(frames, 46);
  out.write("data", 50);
  out.writeUInt32LE(dataBytes, 54);
  const pattern = Buffer.from(Array.from({ length: 256 }, (_, index) => index));
  out.fill(pattern, 58, 58 + dataBytes);
  return out;
}

export function g711WaveControl(
  control: (typeof G711_WAVE_PROVENANCE)[number],
) {
  const bytes = g711WaveBytes(control.formatTag, control.frames);
  if (
    bytes.length !== control.bytes ||
    createHash("sha256").update(bytes).digest("hex") !== control.sha256
  )
    throw new Error("Complete owned G711 control changed");
  return { ...control, data: bytes.toString("base64") };
}
