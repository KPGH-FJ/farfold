/** Owned 2×1 RGB PNG encoded with Pillow, including valid checksums.
 * This fixture is image data, not evidence of browser or Agent acceptance. */
export const PNG_IMAGE_TEST_DATA =
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAIAAAB7QOjdAAAAD0lEQVR4nGP4z8DA0PAfAAgAAn+cRUBOAAAAAElFTkSuQmCC";

/** A controlled decoder peer for exercising callers, never a real decoder. */
export class TestImageDecoder {
  naturalWidth = 2;
  naturalHeight = 1;
  src = "";
  async decode() {}
}
