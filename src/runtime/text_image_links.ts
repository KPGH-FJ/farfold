import { MAX_IMAGE_BYTES, type ImageMime } from "./image_bytes";

export type TextImagePart =
  | { kind: "text"; text: string; offset: number }
  | {
      kind: "image";
      original: string;
      data: string;
      mimeType: ImageMime;
      offset: number;
    };
const encodedLimit = 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

function runEnd(text: string, at: number, delimiter: string) {
  while (text[at] === delimiter) at++;
  return at;
}
function lineStart(text: string, at: number) {
  let start = at;
  // Only zero to three spaces can precede a fence. Inspect that bounded
  // suffix instead of searching the whole line again for each delimiter.
  while (start > 0 && at - start < 4 && text[start - 1] === " ") start--;
  return at - start <= 3 && (start === 0 || text[start - 1] === "\n");
}
function indentedLineEnd(text: string, at: number) {
  let next = at;
  while (next - at < 4 && text[next] === " ") next++;
  if (next - at < 4 && text[next] !== "\t") return at;
  const newline = text.indexOf("\n", next);
  return newline === -1 ? text.length : newline + 1;
}
function skipCode(text: string, at: number, delimiter: string): number {
  const end = runEnd(text, at, delimiter);
  const width = end - at;
  const fenced = width >= 3 && lineStart(text, at);
  let next = end;
  while ((next = text.indexOf(delimiter, next)) !== -1) {
    const close = runEnd(text, next, delimiter);
    if (!fenced) {
      if (close - next === width) return close;
    } else if (close - next >= width && lineStart(text, next)) {
      // A narrower or mid-line delimiter cannot close this fence. Only a
      // possible closing fence needs to inspect its remaining line.
      const lineEnd = text.indexOf("\n", close);
      if (
        /^\s*$/.test(text.slice(close, lineEnd === -1 ? text.length : lineEnd))
      )
        return close;
    }
    next = close;
  }
  // An unfinished code fragment remains literal, including any image examples.
  return text.length;
}

/** Derive display pieces only. No decoding, fetching, mutation or persistence.
 * Deliberately accept just complete inline bitmap data links outside code. */
export function textImageParts(text: string): TextImagePart[] {
  const parts: TextImagePart[] = [];
  const image =
    /\[@image\]\(data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})\)/y;
  let plain = 0;
  let at = 0;
  while (at < text.length) {
    if (at === 0 || text[at - 1] === "\n") {
      const next = indentedLineEnd(text, at);
      if (next !== at) {
        at = next;
        continue;
      }
    }
    if (text[at] === "\\") {
      at += 2;
      continue;
    }
    if (
      text[at] === "`" ||
      (text.startsWith("~~~", at) && lineStart(text, at))
    ) {
      at = skipCode(text, at, text[at]);
      continue;
    }
    if (!text.startsWith("[@image](data:", at)) {
      at++;
      continue;
    }
    image.lastIndex = at;
    const match = image.exec(text);
    if (!match) {
      at++;
      continue;
    }
    const next = at + match[0].length;
    if (match[2].length <= encodedLimit && match[2].length % 4 === 0) {
      if (plain < at)
        parts.push({
          kind: "text",
          text: text.slice(plain, at),
          offset: plain,
        });
      parts.push({
        kind: "image",
        original: match[0],
        mimeType: match[1] as ImageMime,
        data: match[2],
        offset: at,
      });
      plain = next;
    }
    at = next;
  }
  if (plain < text.length || !parts.length)
    parts.push({ kind: "text", text: text.slice(plain), offset: plain });
  return parts;
}
