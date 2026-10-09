import { DocxError, type DocxDocument } from "./docx_types";
/** Each resource is decoded once in the disposable Worker, then immediately closed.
 * Resource and repeated-display pixel budgets were checked before this point. */
export async function decodeDocxImages(document: DocxDocument): Promise<void> {
  if (document.images.length && typeof createImageBitmap !== "function")
    throw new DocxError("unsupported");
  for (const image of document.images) {
    let bitmap: ImageBitmap | undefined;
    try {
      bitmap = await createImageBitmap(
        new Blob([new Uint8Array(image.bytes)], { type: image.mimeType }),
      );
      if (bitmap.width !== image.width || bitmap.height !== image.height)
        throw new DocxError("invalid");
    } catch {
      throw new DocxError("invalid");
    } finally {
      bitmap?.close();
    }
  }
}
