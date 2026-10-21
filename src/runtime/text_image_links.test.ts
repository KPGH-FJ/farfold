import { expect, it } from "vitest";
import { textImageParts } from "./text_image_links";
import { MAX_IMAGE_BYTES } from "./image_bytes";
import { PNG_IMAGE_TEST_DATA } from "./image_fixtures.test-support";

const link = `[@image](data:image/png;base64,${PNG_IMAGE_TEST_DATA})`;
const original = (text: string) =>
  textImageParts(text)
    .map((part) => (part.kind === "text" ? part.text : part.original))
    .join("");

it("derives complete inline image pieces while retaining exact text and byte strings", () => {
  const text = `Before\n${link}between${link}\nAfter`;
  const images = textImageParts(text).filter((part) => part.kind === "image");
  expect(images).toHaveLength(2);
  expect(images[0]).toEqual({
    kind: "image",
    original: link,
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
    offset: 7,
  });
  expect(original(text)).toBe(text);
});

it.each([
  `\\${link}`,
  `\`${link}\``,
  `\`\`${link}\`\``,
  `\`\`\`text\n${link}\n\`\`\`\``,
  `  ~~~text\n${link}\n  ~~~`,
  `\` unfinished code ${link}`,
  `[@image](https://example.com/image.png)`,
  `[@image](file:///private/image.png)`,
  `[@image](image:opaque-file-id)`,
  `[@image](data:image/svg+xml;base64,PHN2Zz4=)`,
  `[@image](data:image/avif;base64,YWJjZA==)`,
  `[@image](data:image/png;base64,Y WJjZA==)`,
  `[@image](data:image/png;base64,YWJjZ)`,
  link.slice(0, -1),
])("keeps untrusted, incomplete and code content literal: %s", (text) => {
  expect(textImageParts(text)).toEqual([{ kind: "text", text, offset: 0 }]);
  expect(original(text)).toBe(text);
});

it("resumes plain image recognition after code closes and distinguishes escaped delimiters", () => {
  for (const prefix of [
    `\`${link}\``,
    `\`\`\`\n${link}\n\`\`\`\`\n`,
    `~~~\n${link}\n~~~\n`,
    "\\\\",
  ]) {
    const text = prefix + link;
    expect(
      textImageParts(text).filter((part) => part.kind === "image"),
    ).toHaveLength(1);
    expect(original(text)).toBe(text);
  }
});

it.each(["    ", "\t", " \t"])(
  "keeps image examples in indented code lines literal: %j",
  (indent) => {
    const text = `${indent}${link}\n${indent}code ${link}`;
    expect(textImageParts(text)).toEqual([{ kind: "text", text, offset: 0 }]);
    expect(original(text)).toBe(text);
  },
);

it("recognizes a plain image after indented code without changing either line", () => {
  const code = `    ${link}\n\t${link}\n`;
  const text = code + link;
  expect(textImageParts(text)).toEqual([
    { kind: "text", text: code, offset: 0 },
    {
      kind: "image",
      original: link,
      data: PNG_IMAGE_TEST_DATA,
      mimeType: "image/png",
      offset: code.length,
    },
  ]);
  expect(original(text)).toBe(text);
});

it("retains oversized encoded content without allowing a preview candidate", () => {
  const text = `[@image](data:image/png;base64,${"A".repeat(4 * Math.ceil(MAX_IMAGE_BYTES / 3) + 4)})`;
  expect(textImageParts(text)).toEqual([{ kind: "text", text, offset: 0 }]);
});

function observedSearches(text: string) {
  const names = ["indexOf", "lastIndexOf"] as const;
  const descriptors = names.map((name) =>
    Object.getOwnPropertyDescriptor(String.prototype, name)!,
  );
  const counts = { indexOf: 0, lastIndexOf: 0 };
  try {
    names.forEach((name, index) => {
      const descriptor = descriptors[index];
      Object.defineProperty(String.prototype, name, {
        ...descriptor,
        value(this: string, search: string, position?: number) {
          const result = Reflect.apply(descriptor.value, this, [
            search,
            position,
          ]);
          if (this === text && search === "\n") counts[name]++;
          return result;
        },
      });
    });
    return { parts: textImageParts(text), counts };
  } finally {
    names.forEach((name, index) =>
      Object.defineProperty(String.prototype, name, descriptors[index]),
    );
  }
}

it("does not rescan an ordinary line for every literal tilde", () => {
  for (const delimiter of ["~", "a"]) {
    const text = "x" + delimiter.repeat(4096) + " tail\n" + link;
    const { parts, counts } = observedSearches(text);
    expect(
      parts
        .map((part) => (part.kind === "text" ? part.text : part.original))
        .join(""),
    ).toBe(text);
    expect(parts.filter((part) => part.kind === "image")).toEqual([
      {
        kind: "image",
        original: link,
        data: PNG_IMAGE_TEST_DATA,
        mimeType: "image/png",
        offset: text.indexOf(link),
      },
    ]);
    expect(counts.lastIndexOf).toBeLessThanOrEqual(1);
    expect(counts.indexOf).toBe(0);
  }
});

it.each([
  "```\nx" + "`x".repeat(1024) + "\n```\n",
  "``x" + "`x".repeat(1024) + "``\n",
])("does not scan the line end for narrower code delimiters", (prefix) => {
  const text = prefix + link;
  const { parts, counts } = observedSearches(text);
  expect(parts).toEqual([
    { kind: "text", text: prefix, offset: 0 },
    {
      kind: "image",
      original: link,
      data: PNG_IMAGE_TEST_DATA,
      mimeType: "image/png",
      offset: prefix.length,
    },
  ]);
  expect(counts.indexOf).toBeLessThanOrEqual(1);
  expect(counts.lastIndexOf).toBeLessThanOrEqual(1);
});

it.each(["", " ", "  ", "   "])(
  "keeps eligible fence indentation %j and wider whitespace-only closers",
  (indent) => {
    const prefix = `🙂\r\n${indent}~~~text\n${link}\n${indent}~~~~\t\r\n`;
    const text = prefix + link;
    expect(textImageParts(text)).toEqual([
      { kind: "text", text: prefix, offset: 0 },
      {
        kind: "image",
        original: link,
        data: PNG_IMAGE_TEST_DATA,
        mimeType: "image/png",
        offset: prefix.length,
      },
    ]);
  },
);
