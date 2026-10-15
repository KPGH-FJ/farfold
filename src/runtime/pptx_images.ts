import { inspectDocxImage } from "./docx_images";
import { DocxError } from "./docx_types";
import { PptxError, PPTX_LIMITS, type PptxImage } from "./pptx_types";
import type { PptxPackage } from "./pptx_package";

/** Pure bytes/EXIF inspection. Actual decoding is separately required by the
 * Worker and UI adoption gates; neither header nor file suffix proves pixels. */
export function inspectPptxImage(
  bytes: Uint8Array,
): Pick<PptxImage, "mimeType" | "width" | "height"> {
  if (bytes.length > PPTX_LIMITS.imageBytes) throw new PptxError("limit");
  try {
    const value = inspectDocxImage(bytes);
    if (value.mimeType !== "image/png" && value.mimeType !== "image/jpeg")
      throw new PptxError("unsupported");
    return { ...value, mimeType: value.mimeType };
  } catch (e) {
    if (e instanceof PptxError) throw e;
    throw new PptxError(e instanceof DocxError ? e.code : "invalid");
  }
}
export class PptxImages {
  readonly images = new Map<string, PptxImage>();
  private pixels = 0;
  constructor(private readonly pkg: PptxPackage) {}
  get(part: string): PptxImage {
    const cached = this.images.get(part);
    if (cached) return cached;
    const bytes = this.pkg.parts.get(part);
    if (!bytes) throw new PptxError("invalid");
    const info = inspectPptxImage(bytes);
    if (this.pkg.mime(part) !== info.mimeType) throw new PptxError("invalid");
    this.pixels += info.width * info.height;
    if (
      this.images.size >= PPTX_LIMITS.images ||
      this.pixels > PPTX_LIMITS.imagePixels
    )
      throw new PptxError("limit");
    const result = { id: part, bytes, ...info };
    this.images.set(part, result);
    return result;
  }
}
