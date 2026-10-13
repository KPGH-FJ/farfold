import type { AudioCapture } from "./audio_input";
import type { DraftAttachment } from "./drafts";
// Frozen CPython wave fixture, independently read by stdlib wave; no product
// parser generates these bytes. Complete-file SHA (including header):
// eb2ff3091658e70d7364f6350c88c37321b0aac4000586fe62532054bd8b6574
export const AUDIO_FIXTURE_DATA =
  "UklGRnQCAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVACAABDRUhKTU9SVFdZXF5hY2Zoa21wcnV3enx/gYSGiYuOkJOVmJqdn6Kkp6msrrGztri7u7i2s7GurKmnpKKfnZqYlZOQjouJhoSBf3x6d3VycG1raGZjYV5cWVdUUk9NSkhFQ0VISk1PUlRXWVxeYWNmaGttcHJ1d3p8f4GEhomLjpCTlZianZ+ipKeprK6xs7a4u7u4trOxrqypp6Sir6yopKCdmZWRjoqGgn97d3NwbGhkYV1ZVVJOSkZDPzs3NDAsKCUoLDA0Nzs/Q0ZKTlJVWV1hZGhscHN3e3+ChoqOkZWZnaCkqKyvs7e7vsLGys3R1dnZ1dHNysbCvru3s6+sqKSgnZmVkY6KhoJ/e3dzcGxoZGFdWVVSTkpGQz87NzQwLCglKCwwNDc7P0NGSk5SVVldYWRobHBzd3x/gYSGiYuOkJOVmJqdn6Kkp6msrrGztri7u7i2s7GurKmnpKKfnZqYlZOQjouJhoSBf3x6d3VycG1raGZjYV5cWVdUUk9NSkhFQ0VISk1PUlRXWVxeYWNmaGttcHJ1d3p8f4GEhomLjpCTlZianZ+ipKeprK6xs7a4u7u4trOxrqypp6Sin52amJWTkI6LiYaEgX98end1cnBta2hZVVJOSkZDPzs3NDAsKCUoLDA0Nzs/Q0ZKTlJVWV1hZGhscHN3e3+ChoqOkZWZnaCkqKyvs7e7vsLGys3R1dnZ1dHNysbCvru3s6+sqKSgnZmVkY6KhoJ/e3dzcGxoZGFdWVVSTkpGQz87NzQwLCglKCwwNDc7P0NG";
export function audioCapture(): AudioCapture {
  return {
    file: {
      root: "/chosen",
      path: "/chosen/sample.wav",
      resolvedPath: "/chosen/sample.wav",
      name: "sample.wav",
      size: 636,
      sha256:
        "eb2ff3091658e70d7364f6350c88c37321b0aac4000586fe62532054bd8b6574",
      version: "fixture-v1",
    },
    data: AUDIO_FIXTURE_DATA,
    mimeType: "audio/wav",
    channels: 1,
    sampleRate: 8000,
    bitsPerSample: 8,
    frames: 592,
    durationMs: 74,
  };
}
export function audioAttachment(): DraftAttachment {
  const { data, mimeType, ...localAudio } = audioCapture();
  return {
    id: "audio",
    kind: "audio",
    name: "sample.wav",
    uri: "file:///chosen/sample.wav",
    data,
    mimeType,
    localAudio,
  };
}

// Lossless expansion of the independent exact-16MiB fixture; its frozen 512-byte
// waveform repeats. This is a byte fixture, not a second RIFF parser.
export function largeAudioCapture(): AudioCapture {
  const bytes = Buffer.alloc(16777216);
  Buffer.from(
    "UklGRvj//wBXQVZFZm10IBAAAAABAAIAAHcBAADuAgACAAgAZGF0YdT//wA=",
    "base64",
  ).copy(bytes);
  bytes.fill(
    Buffer.from(
      "tMbT1BHJ6dVuy//Wys0V2CjQK9mE0kHa4dRX2z7Xbdyb2YPd+NuZ3lTer9+x4MXgDuPc4Wvl8uLI5wjkJOoe5YLsNObe7krnO/Fg6Jjzdun19YzqUvii6676uOwL/c7taP/k7sUB+u8iBBDxfgYm8twIPPM4C1L0lQ1o9fIPfvZPEpT3rBSq+AgXwPlmGdb6whvs+x8eA/18IBn+2SIv/zYlRQCSJ1sB7ylxAkwshwOpLp0EBjGzBWIzyQbANd8HHDj1CBw4CwrANSILYjM4DAYxTg2pLmQOTCx6D+8pkBCSJ6YRNiW8Etki0hN8IOgUHx7+FcIbFBdmGSoYCBdAGawUVhpPEmwb8g+CHJUNmB04C64e3AjEH34G2iAiBPAhxQEGI2j/HCQL/TMlrvpJJlL4Xyf19XUomPOLKTvxoSre7rcrguzNLCTq4y3I5/kua+UPMA7jJTGx4DsyVN5SM/jbaDSb2X41PteUNuHUqjeE0sA4KNDAOMrNqjduy5Q2Ecl+NbTGaDQRyVIzbss7MsrNJTEo0A8whNL5LuHU4y0+180sm9m3K/jboSpU3ospseB1KA7jXydr5UkmyOczJSTqHCSC7AYj3u7wITvx2iCY88Qf9fWuHlL4mB2u+oIcC/1sG2j/VhrFAUAZIgQqGH4GFBfcCP4VOAvoFJUN0hM=",
      "base64",
    ),
    44,
  );
  return {
    ...audioCapture(),
    file: {
      ...audioCapture().file,
      size: 16777216,
      sha256:
        "2aa96f22539756ff5af208c5cd9ae1ed2b2307faa03a13f185cf64b234a7bcad",
    },
    data: bytes.toString("base64"),
    channels: 2,
    sampleRate: 96000,
    bitsPerSample: 8,
    frames: 8388586,
    durationMs: 87382,
  };
}
