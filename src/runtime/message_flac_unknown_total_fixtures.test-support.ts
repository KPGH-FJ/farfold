import { flacTestFile } from "./message_flac_fixtures.test-support";

/** Exact complete public2s control from native-run1/short2s-unknown-total.flac.
 * Captured full-EOF PCM matches the original2s reference; whole runner failed
 * its group-observation gate. Not WebKit/App/Agent evidence. */
export const SHORT_UNKNOWN_TOTAL =
  "ZkxhQwAAACISABIAAATQAAWZAfQA8AAAAADXVkmo8F3HDF1jEUvJOST/hAAANgUAAABBcHBsZQEAAAAlAAAAV0FWRUZPUk1BVEVY" +
  "VEVOU0lCTEVfQ0hBTk5FTF9NQVNLPTB4NP/4VAgArUQAAAKlBPu1GvnpXsAhJIUnJzIcmSTnOcmTJnMlJk5znOZOEzk5KSTDPQ5O" +
  "TNJz5MmTJznMmcOcmTJkyZyWZOTh8pkkKTk5kOTJJznOTJkzmSkyc5znMnCZyclJJhnocnJmk58mTJk5zmTOHOTJkyZM5LMnJw+U" +
  "ySFJycyHJkk5znJkyZzJSZOc5zmThM5OSkkwz0OTkzSc+TJkyc5zJnDnJkyZMmclmTk4fKZJCk5OZDkySc5zkyZM5kpMnOc5zJwm" +
  "cnJSSYZ6HJyZpOfJkyZOc5kzhzkyZMmTOSzJycPlMkhScnMhyZJOc5yZMmcyUmTnOc5k4TOTkpJMM9Dk5M0nPkyZMnOcyZw5yZMm" +
  "TJnJZk5OHymSQpOTmQ5MknOc5MmTOZKTJznOcycJnJyUkmGehycmaTnyZMmTnOZM4c5MmTJkzksycnD5TJIUnJzIcmSTnOcmTJnM" +
  "lJk5znOZOEzk5KSTDPQ5OTNJz5MmTJznMmcOcmTJkyZyWZOTh8pkkKTk5kOTJJznOTJkzmSkyc5znMnCZyclJJhnocnJmk58mTJk" +
  "5zmTOHOTJkyZM5LMnJw+UySFJycyHJkk5znJkyZzJSZOc5zmThM5OSkkwz0OTkzSc+TJkyc5zJnDnJkyZMmclmTk4fKZJCk5OZDk" +
  "ySc5zkyZM5kpMnOc5zJwmcnJSSYZ6HJyZpOfJkyZOc5kzhzkyZMmTOSzJycPlMkhScnMhyZJOc5yZMmcyUmTnOc5k4TOTkpJMM9D" +
  "k5M0nPkyZMnOcyZw5yZMmTJnJZk5OHymSQpOTmQ5MknOc5MmTOZKTJznOcycJnJyUkmGQ6HJyZpOfJkyZOc5kzhzkyZMmTOSzJyc" +
  "PlMkhScnMhyZJOc5yZMmcyUmTnOc5k4TOTkpJMM9Dk5M0nPkyZMnOcyZw5yZMmTJnJZk5OHymSQpOTmQ5MknOc5MmTOZKTJznOcy" +
  "cJnJyUkmGehycmaTnyZMmTnOZM4c5MmTJkzksycnD5TJIUnJzIcmSTnOcmTJnMlJk5znOZOEzk5KSTDPQ5OTNJz5MmTJznMmcOcm" +
  "TJkyZyWZOTh8pkkKTk5kOTJJznOTJkzmSkyc5znMnCZyclJJhnocnJmk58mTJk5zmTOHOTJkyZM5LMnJw+UySFJycyHJkk5znJky" +
  "ZzJSZOc5zmThM5OSkkwz0OTkzSc+TJkyc5zJnDnJkyZMmclmTk4fKZJCk5OZDkySc5zkyZM5kpMnOc5zJwmcnJSSYZ6HJyZpOfJk" +
  "yZOc5kzhzkyZMmTOSzJycPlMkhScnMhyZJOc5yZMmcyUmTnOc5k4TOTkpJMM9Dk5M0nPkyZMnOcyZw5yZMmTJnJZk5OHymSQpOTm" +
  "Q5MknOc5MmTOZKTJznOcycJnJyUkmGehycmaTnyZMmTnOZM4c5MmTJkzksycnD5TJIUnJzIcmSTnOcmTJnMlJk5znOZOEzk5KSTD" +
  "PQ5OTNJz5MmTJznMmcOcmTJkyZyWZOTh8pkkKTk5kOTJJznOTJkzmSkyc5znMnCZyclJJhnocnJmk58mTJk5zmTOHOTJkyZM5LMn" +
  "Jw+UySFJycyHJkk5znJkyZzJSZOc5zmThM5OSkkwz0OTkzSc+TJkyc5zJnDnJkyZMmclmTk4fKZJCKhN//hUCAGqSALgAD/9lvs2" +
  "+We1AiiklLlfUMAhJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkmTOTOZJzJk" +
  "yZzMzk+TJMyXJ8pMMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOckOZ5zJzJn" +
  "kznOZMzMnJJzzOEnJJhymEymTJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkm" +
  "TOTOZJzJkyZzMzk+TJMyXJ8pMMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOc" +
  "kOZ5zJzJnkznOZMzMnJJzzOEnJJhymEymTJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKY" +
  "TKZMnSZkmTOTOZJzJkyZzMzk+TJMyXJ8pMMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJc" +
  "nykwyzDOckOZ5zJzJnkznOZMzMnJJzzOEnJJhymEymTJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknP" +
  "M4SckmHKYTKZMnSZkmTOTOZJzJkyZzMzk+TJMyXJ8pMMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnM" +
  "zOT5MkzJcnykwyzDMJyQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkmTOTOZJzJkyZzMzk+TJMyXJ8pMMswznJDmecycyZ5M5" +
  "zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOckOZ5zJzJnkznOZMzMnJJzzOEnJJhymEymTJ0mZJkzk" +
  "zmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkmTOTOZJzJkyZzMzk+TJMyXJ8pMMswznJDm" +
  "ecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOckOZ5zJzJnkznOZMzMnJJzzOEnJJhymEym" +
  "TJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkmTOTOZJzJkyZzMzk+TJMyXJ8p" +
  "MMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOckOZ5zJzJnkznOZMzMnJJzzOE" +
  "nJJhymEymTJ0mZJkzkzmScyZMmczM5PkyTMlyfKTDLMM5yQ5nnMnMmeTOc5kzMycknPM4SckmHKYTKZMnSZkmTOTOZJzJkyZzMzk" +
  "+TJMyXJ8pMMswznJDmecycyZ5M5zmTMzJySc8zhJySYcphMpkydJmSZM5M5knMmTJnMzOT5MkzJcnykwyzDOckOZ5zJzJnkznOZM" +
  "zMnJJzzOEnJJhymEymTJL4P/+FQIAqNE+qf85v+CtRtR318QISySEkOepZJCGEz3SZCSEz15hCYTN1lCSEhnpXyEhMJ7pMkhDCep" +
  "ZkkJIc3ZkkISTKyzISQhMLtMkhhCSTbLJISQ56lkkIYTPdJkJITPXmEJhM3WUJISGelfISEwnukySEMJ6lmSQkhzdmSQhJMrLMhJ" +
  "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" +
  "aRpCVIUjSMZRhCEoSlCkoSlKMoyjCEoUlKVIUlKMowlCEoSlKkoUhKEowhCEo0lKFIUhKEowlGEoSlKUqQhSNIyhGUaRpSFJSlCU" +
  "ISjCUIQpCkKSlCUYQhGUYQpCkoSlCUIQjCUZQlCkpSlCkYQlGUZQlCkoUlCUIQhCMpRpGkJUhSNIxlGEIShKUKShKUoyjKMIShSU" +
  "pUhSUoyjCUIShKUqShSEoSjCEISjSUoUhSEoSjCUYShKUpSpCFI0jKEZRpGlIUlKUJQhKMJQhCkKQpKUJRhCEZRhCkKShKUJQhCM" +
  "JRlCUKSlKUKRhCUZRlCUKShSUJQhCEIylGkaQlSFI0jGUYQhKEpQpKEpSjKMowhKFJSlSFJSjKMJQhKEpSpKFIShKMIQhKNJShSF" +
  "IShKMJRhKEpSlKkIUjSMoRlGkaUhSUpQlCEowlCEKQpCkpQlGEIRlGEKQpKEpQlCEIwlGUJQpKUpQpGEJRlGUJQpKFJQlCEIQjKU" +
  "aRpCVIUjSMZRhCEoSlCkoSlKMoyjCEoUlKVIUlKMowlCEoSlKkoUhKEowhCEo0lKFIUhKEowlGEoSlKUqQhSNIyhGUaRpSFJSlCU" +
  "ISjCUIQpCkKSlCUYQhGUYQpCkoSlCUIQjCUZQlCkpSlCkYQlGUZQlCkoUlCUIQhCMpRpGkJUhSNIxlGEIShKUKShKUoyjKMIShSU" +
  "pUhSUoyjCUIShKUqShSEoSjCEISjSUoUhSEoSjCUYShKUpSpCFI0jKEZRpGlIUlKUJQhKMJQhCkKQpKUJRhCEZRhCkKShKUJQhCM" +
  "JRlCUKSlKUKRhCUZRlCUKShSUJQhCEIylGkaQlSFI0jGUYQhKEpQpKEpSjKMowhKFJSlSFJSjKMJQhKEpSpKFIShKMIQhKNJShSF" +
  "IShKMJRhKEpSlKkIUjSMoRlGkaUhSUpQlCEowlCEKQpCkpQlGEIRlGEKQpKEpQlCEIwlGUJQpKUpQpGEJRlGUJQpKFJQlCEIQjKU" +
  "aRpCVIUjSMZRhCEoSlCkoSlKMoyjCEoUlKVIUlKMowlCEoSlKkoUhKEowhCEo0lKFIUhKEowlGEoSlKUqQhSNIyhGUaRpSFJSlCU" +
  "ISjCUIQpCkKSlCUYQhGUYQpCkoSlCUIQjCUZQlCkpSlCkYQlGUZQlCkoUlCUIQhCMpRpGgDIsg==";

export function unknownTotal(data: string): string {
  const bytes = Buffer.from(data, "base64");
  bytes.writeBigUInt64BE(bytes.readBigUInt64BE(18) & ~((1n << 36n) - 1n), 18);
  return bytes.toString("base64");
}

// Structural test construction only. This does not invoke a decoder or prove
// the newly constructed600s/boundary/invalid controls play in a browser.
function crc(bytes: Buffer, bits: number, polynomial: number): number {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte << (bits - 8);
    for (let bit = 0; bit < 8; bit++)
      result =
        ((result << 1) ^ (result & (1 << (bits - 1)) ? polynomial : 0)) &
        ((1 << bits) - 1);
  }
  return result;
}

function codedNumber(value: number): Buffer {
  if (value < 128) return Buffer.from([value]);
  const length = value < 2048 ? 2 : value < 65_536 ? 3 : 4;
  const bytes = Buffer.alloc(length);
  for (let at = length - 1; at > 0; at--) {
    bytes[at] = 0x80 | (value & 0x3f);
    value >>>= 6;
  }
  bytes[0] = ((0xff << (8 - length)) & 0xff) | value;
  return bytes;
}

export function constantUnknownTotal(
  samples: number,
  options: {
    blockSize?: number;
    duplicateSecond?: boolean;
    paddingRecords?: number;
  } = {},
): string {
  const blockSize = options.blockSize ?? 4096;
  const frames: Buffer[] = [];
  for (let index = 0, at = 0; at < samples; index++, at += blockSize) {
    const count = Math.min(blockSize, samples - at);
    const code = count === 4096 ? 12 : 7;
    let header = Buffer.concat([
      Buffer.from([255, 248, (code << 4) | 4, 8]),
      codedNumber(options.duplicateSecond && index === 1 ? 0 : index),
    ]);
    if (code === 7) {
      const size = Buffer.alloc(2);
      size.writeUInt16BE(count - 1);
      header = Buffer.concat([header, size]);
    }
    header = Buffer.concat([header, Buffer.from([crc(header, 8, 0x07)])]);
    const body = Buffer.concat([header, Buffer.from([0, 0, 0])]);
    const footer = Buffer.alloc(2);
    footer.writeUInt16BE(crc(body, 16, 0x8005));
    frames.push(Buffer.concat([body, footer]));
  }
  return flacTestFile({
    totalSamples: 0,
    minBlock: blockSize,
    maxBlock: blockSize,
    blocks: Array.from({ length: options.paddingRecords ?? 0 }, () => ({
      type: 1,
      data: Buffer.alloc(0),
    })),
    audio: Buffer.concat(frames),
  }).toString("base64");
}
