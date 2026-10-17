import {
  messageJpegAdmission,
  messageBmpAdmission,
} from "./message_raster_jpeg_bmp";
import { messageGifAdmission } from "./message_raster_gif";
import { messageWebpAdmission } from "./message_raster_webp";
import {
  MessageRasterError,
  MessageRasterReader,
  type MessageRasterRejection,
} from "./message_raster_reader";

/** Called after canonical Base64, byte admission and the existing PNG check.
 * Actual signatures are checked across all allowed image MIME declarations.
 * AVIF and PNG animation are outside this structural preflight. The browser
 * remains responsible for decoding; these declarations do not bound its heap. */
export function messageRasterAdmission(
  data: string,
  mime: string,
): "withinBudget" | "notCovered" | MessageRasterRejection {
  const reader = new MessageRasterReader(data);
  try {
    if (reader.matches(0, "\xff\xd8\xff")) messageJpegAdmission(reader);
    else if (reader.matches(0, "GIF87a") || reader.matches(0, "GIF89a"))
      messageGifAdmission(reader);
    else if (reader.matches(0, "RIFF") && reader.matches(8, "WEBP"))
      messageWebpAdmission(reader);
    else if (reader.matches(0, "BM")) messageBmpAdmission(reader);
    else
      return /^image\/(?:jpeg|gif|webp|bmp)$/.test(mime)
        ? "invalid"
        : "notCovered";
    return "withinBudget";
  } catch (error) {
    if (error instanceof MessageRasterError) return error.reason;
    throw error;
  }
}
