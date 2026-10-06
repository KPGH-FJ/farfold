import { afterEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));
import {
  IMAGE_INPUT_STRINGS as S,
  clipboardImageCandidate,
  draftImagePreview,
  imageInputError,
  selectedImageCandidate,
  validateDraftImage,
} from "./draft_images";
import { IMAGE_BYTES_STRINGS, MAX_IMAGE_BYTES } from "./image_bytes";
import {
  PNG_IMAGE_TEST_DATA,
  TestImageDecoder,
} from "./image_fixtures.test-support";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  h.invoke.mockReset();
});

it("passes the exact validated bytes to the decoder, then releases its element", async () => {
  let element!: TestImageDecoder;
  const decode = vi.fn();
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      constructor() {
        super();
        element = this;
      }
      override async decode() {
        decode(this.src);
      }
    },
  );
  expect(await validateDraftImage(PNG_IMAGE_TEST_DATA, "image/png")).toEqual({
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
  });
  expect(decode).toHaveBeenCalledExactlyOnceWith(
    `data:image/png;base64,${PNG_IMAGE_TEST_DATA}`,
  );
  expect(element.src).toBe("");
  await expect(
    validateDraftImage(PNG_IMAGE_TEST_DATA, "image/jpeg"),
  ).rejects.toThrow(S.invalid);
  expect(decode).toHaveBeenCalledTimes(1);
});

it("rejects SVG and a signature-only bitmap before constructing a decoder", async () => {
  const image = vi.fn();
  vi.stubGlobal("Image", image);
  for (const data of [
    btoa("<svg xmlns='http://www.w3.org/2000/svg'/>"),
    btoa("\x89PNG\r\n\x1a\n"),
  ]) {
    await expect(validateDraftImage(data)).rejects.toThrow(
      IMAGE_BYTES_STRINGS.invalid,
    );
  }
  expect(image).not.toHaveBeenCalled();
});

it("maps real decoder failure to fixed text and rechecks decoded dimensions", async () => {
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      override async decode() {
        throw new Error("private decoder detail");
      }
    },
  );
  await expect(validateDraftImage(PNG_IMAGE_TEST_DATA)).rejects.toThrow(
    S.invalid,
  );
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      override naturalWidth = 9000;
    },
  );
  await expect(validateDraftImage(PNG_IMAGE_TEST_DATA)).rejects.toThrow(
    IMAGE_BYTES_STRINGS.tooManyPixels,
  );
  expect(
    imageInputError("图片大小超过 8 MiB，请缩小后重新添加。 private suffix"),
  ).toBe(S.invalid);
});

it("times out callers while keeping genuinely unfinished decoder slots bounded", async () => {
  vi.useFakeTimers();
  const finish: (() => void)[] = [];
  const elements: TestImageDecoder[] = [];
  vi.stubGlobal(
    "Image",
    class extends TestImageDecoder {
      constructor() {
        super();
        elements.push(this);
      }
      override decode() {
        return new Promise<void>((resolve) => finish.push(resolve));
      }
    },
  );
  const first = validateDraftImage(PNG_IMAGE_TEST_DATA).catch(
    (error) => error as Error,
  );
  const second = validateDraftImage(PNG_IMAGE_TEST_DATA).catch(
    (error) => error as Error,
  );
  try {
    await vi.advanceTimersByTimeAsync(15_000);
    expect(((await first) as Error).message).toBe(S.decodeWaitExpired);
    expect(((await second) as Error).message).toBe(S.decodeWaitExpired);
    expect(elements.every((image) => image.src === "")).toBe(true);
    await expect(validateDraftImage(PNG_IMAGE_TEST_DATA)).rejects.toThrow(
      S.decodeBusy,
    );
    expect(elements).toHaveLength(2);
  } finally {
    finish.forEach((resolve) => resolve());
    await Promise.resolve();
    await Promise.resolve();
  }
  vi.stubGlobal("Image", TestImageDecoder);
  await expect(validateDraftImage(PNG_IMAGE_TEST_DATA)).resolves.toMatchObject({
    mimeType: "image/png",
  });
});

it("bounds clipboard reads before allocating and derives MIME from bytes rather than the type hint", async () => {
  const arrayBuffer = vi.fn();
  await expect(
    clipboardImageCandidate({
      size: MAX_IMAGE_BYTES + 1,
      arrayBuffer,
    } as unknown as File),
  ).rejects.toThrow(IMAGE_BYTES_STRINGS.tooLarge);
  expect(arrayBuffer).not.toHaveBeenCalled();
  const bytes = Uint8Array.from(atob(PNG_IMAGE_TEST_DATA), (char) =>
    char.charCodeAt(0),
  );
  const candidate = await clipboardImageCandidate({
    size: bytes.length,
    type: "image/jpeg",
    arrayBuffer: async () => bytes.buffer,
  } as unknown as File);
  expect(candidate).toEqual({
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
  });
});

it("keeps unknown backend payloads and decorated errors behind fixed local messages", async () => {
  h.invoke.mockResolvedValue({
    mimeType: "image/png",
    data: PNG_IMAGE_TEST_DATA,
    private: "private payload",
  });
  await expect(
    selectedImageCandidate("file:///chosen.png", true),
  ).rejects.toThrow(S.invalid);
  h.invoke.mockRejectedValue({ message: "private backend detail" });
  await expect(
    selectedImageCandidate("file:///chosen.png", true),
  ).rejects.toThrow(S.invalid);
});

it("previews only the exact checked current input, never a recovered, loading or changed image", () => {
  const checked = {
    data: PNG_IMAGE_TEST_DATA,
    mimeType: "image/png",
    uri: "file:///own.png",
  };
  const attachment = {
    id: "image",
    kind: "image" as const,
    name: "own.png",
    ...checked,
    imageChecked: checked,
  };
  expect(draftImagePreview(attachment)).toBe(
    `data:image/png;base64,${PNG_IMAGE_TEST_DATA}`,
  );
  for (const change of [
    { loading: true },
    { recovered: true },
    { data: "changed" },
    { mimeType: "image/jpeg" },
    { uri: "file:///other.png" },
    { imageChecked: undefined },
  ])
    expect(draftImagePreview({ ...attachment, ...change })).toBeNull();
});
