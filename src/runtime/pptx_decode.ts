import { PptxError, type PptxDocument } from "./pptx_types";

/** Decode bounded, inspected bitmap bytes in the disposable Worker. Close each
 * decoded resource immediately; no image URL or remote decoder input exists. */
export async function decodePptxImages(document: PptxDocument): Promise<void> {
  if (document.images.length && typeof createImageBitmap !== "function")
    throw new PptxError("unsupported");
  for (const image of document.images) {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
      );
      if (bitmap.width !== image.width || bitmap.height !== image.height)
        throw new PptxError("invalid");
    } catch {
      throw new PptxError("invalid");
    } finally {
      bitmap?.close();
    }
  }
}
